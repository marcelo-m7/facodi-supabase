import { HttpError } from "./v2_http.ts";
import type { AdminClient } from "./v2_supabase.ts";
import { facodi, unwrap } from "./v2_supabase.ts";
import { failJob, updateJob } from "./v2_jobs.ts";
import { runPipelineStage } from "./v2_video_pipeline_steps.ts";

export const DEFAULT_PIPELINE_STAGES = [
  "v2_fetch_youtube_metadata",
  "v2_extract_video_content",
  "v2_match_video_candidates",
  "v2_classify_video",
] as const;

export const PIPELINE_STAGES = [...DEFAULT_PIPELINE_STAGES, "v2_generate_embeddings"] as const;

export type PipelineStage = typeof PIPELINE_STAGES[number];

export interface ProcessPipelinePayload {
  job_id: string;
  stages?: string[];
  retry_failed?: boolean;
  request_id?: string;
}

export interface PipelineEventInput {
  job_id: string;
  event_type:
    | "pipeline_started"
    | "pipeline_succeeded"
    | "pipeline_failed"
    | "stage_started"
    | "stage_succeeded"
    | "stage_failed"
    | "retry_scheduled";
  step: string;
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "needs_review"
    | "cancelled"
    | "retrying";
  attempt?: number;
  request_id: string;
  error_code?: string | null;
  message?: string | null;
  metadata?: Record<string, unknown>;
}

export interface LoggedPipelineEvent extends PipelineEventInput {
  id?: string;
  requested_by?: string | null;
  created_at?: string;
}

interface StageError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

const MAX_STAGE_ATTEMPTS = 3;

function isPipelineStage(value: string): value is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(value);
}

function normalizeStages(stages: string[] | undefined): PipelineStage[] {
  if (!stages || stages.length === 0) {
    return [...DEFAULT_PIPELINE_STAGES];
  }
  const normalized = stages.map((stage) => stage.trim()).filter(Boolean);
  const invalid = normalized.filter((stage) => !isPipelineStage(stage));
  if (invalid.length > 0) {
    throw new HttpError(
      400,
      "invalid_pipeline_stage",
      `Invalid pipeline stage(s): ${invalid.join(", ")}`,
    );
  }
  return normalized as PipelineStage[];
}

function isRecoverableStageError(error: StageError): boolean {
  if (error.status === 408 || error.status === 429) {
    return true;
  }
  if (error.status >= 500) {
    return true;
  }
  return [
    "youtube_public_blocked",
    "supabase_error",
    "unexpected_error",
  ].includes(error.code);
}

function toStageError(error: unknown): StageError {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }
  if (error instanceof Error) {
    return {
      status: 500,
      code: "unexpected_error",
      message: error.message,
    };
  }
  return {
    status: 500,
    code: "unexpected_error",
    message: "Unexpected pipeline error.",
  };
}

async function jobRequestedBy(
  admin: AdminClient,
  jobId: string,
): Promise<string | null> {
  const job = await facodi(admin)
    .from("analysis_jobs")
    .select("requested_by")
    .eq("id", jobId)
    .maybeSingle<{ requested_by: string | null }>();
  if (job.error) {
    throw new HttpError(500, "supabase_error", job.error.message);
  }
  return job.data?.requested_by ?? null;
}

export async function logJobEvent(
  admin: AdminClient,
  input: PipelineEventInput,
): Promise<LoggedPipelineEvent> {
  const requestedBy = await jobRequestedBy(admin, input.job_id);
  const row = {
    job_id: input.job_id,
    requested_by: requestedBy,
    event_type: input.event_type,
    step: input.step,
    status: input.status,
    attempt: input.attempt ?? 1,
    request_id: input.request_id,
    error_code: input.error_code ?? null,
    message: input.message ?? null,
    metadata: input.metadata ?? {},
  };
  const inserted = unwrap<{ id: string; created_at: string }>(
    await facodi(admin)
      .from("analysis_job_events")
      .insert(row)
      .select("id, created_at")
      .single(),
  );
  return {
    ...row,
    id: inserted.id,
    created_at: inserted.created_at,
  };
}

export async function listJobEvents(
  admin: AdminClient,
  jobId: string,
): Promise<LoggedPipelineEvent[]> {
  const result = await facodi(admin)
    .from("analysis_job_events")
    .select("*")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true });
  if (result.error) {
    throw new HttpError(500, "supabase_error", result.error.message);
  }
  return (result.data ?? []) as LoggedPipelineEvent[];
}

async function runStageWithRetries(
  admin: AdminClient,
  stage: PipelineStage,
  jobId: string,
  requestId: string,
  events: LoggedPipelineEvent[],
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_STAGE_ATTEMPTS; attempt += 1) {
    await updateJob(admin, jobId, {
      status: "running",
      current_step: stage,
      attempts: attempt,
      started_at: new Date().toISOString(),
    });
    events.push(await logJobEvent(admin, {
      job_id: jobId,
      event_type: "stage_started",
      step: stage,
      status: "running",
      attempt,
      request_id: requestId,
    }));

    try {
      const data = await runPipelineStage(admin, stage, { job_id: jobId });
      events.push(await logJobEvent(admin, {
        job_id: jobId,
        event_type: "stage_succeeded",
        step: stage,
        status: "succeeded",
        attempt,
        request_id: requestId,
        metadata: { response: data },
      }));
      return;
    } catch (error) {
      const stageError = toStageError(error);
      const recoverable = isRecoverableStageError(stageError);
      events.push(await logJobEvent(admin, {
        job_id: jobId,
        event_type: "stage_failed",
        step: stage,
        status: "failed",
        attempt,
        request_id: requestId,
        error_code: stageError.code,
        message: stageError.message,
        metadata: {
          recoverable,
          details: stageError.details ?? null,
        },
      }));

      if (recoverable && attempt < MAX_STAGE_ATTEMPTS) {
        events.push(await logJobEvent(admin, {
          job_id: jobId,
          event_type: "retry_scheduled",
          step: stage,
          status: "retrying",
          attempt: attempt + 1,
          request_id: requestId,
          error_code: stageError.code,
          message: stageError.message,
        }));
        continue;
      }
      throw new HttpError(stageError.status, stageError.code, stageError.message, stageError.details);
    }
  }
}

export async function processVideoPipeline(
  admin: AdminClient,
  payload: ProcessPipelinePayload,
): Promise<{
  success: boolean;
  job_id: string;
  status: string;
  current_step: string;
  classification_id: string | null;
  request_id: string;
  events: LoggedPipelineEvent[];
}> {
  if (!payload.job_id) {
    throw new HttpError(400, "missing_job_id", "Pipeline processing requires job_id.");
  }
  const requestId = payload.request_id ?? crypto.randomUUID();
  const stages = normalizeStages(payload.stages);
  const db = facodi(admin);
  const job = unwrap<Record<string, unknown>>(
    await db.from("analysis_jobs").select("*").eq("id", payload.job_id).maybeSingle(),
  );
  if (job.status === "failed" && payload.retry_failed !== true) {
    throw new HttpError(409, "job_failed_retry_required", "Set retry_failed=true to retry a failed job.");
  }

  const events: LoggedPipelineEvent[] = [];
  events.push(await logJobEvent(admin, {
    job_id: payload.job_id,
    event_type: "pipeline_started",
    step: "pipeline",
    status: "running",
    request_id: requestId,
    metadata: { stages },
  }));

  try {
    for (const stage of stages) {
      await runStageWithRetries(admin, stage, payload.job_id, requestId, events);
    }
  } catch (error) {
    const stageError = toStageError(error);
    await failJob(admin, payload.job_id, new HttpError(
      stageError.status,
      stageError.code,
      stageError.message,
      stageError.details,
    ));
    events.push(await logJobEvent(admin, {
      job_id: payload.job_id,
      event_type: "pipeline_failed",
      step: "pipeline",
      status: "failed",
      request_id: requestId,
      error_code: stageError.code,
      message: stageError.message,
      metadata: { details: stageError.details ?? null },
    }));
    throw error;
  }

  const [finalJob, classification] = await Promise.all([
    db.from("analysis_jobs").select("status,current_step").eq("id", payload.job_id).single(),
    db
      .from("video_classifications")
      .select("id")
      .eq("job_id", payload.job_id)
      .maybeSingle<{ id: string }>(),
  ]);
  if (finalJob.error) {
    throw new HttpError(500, "supabase_error", finalJob.error.message);
  }
  if (classification.error) {
    throw new HttpError(500, "supabase_error", classification.error.message);
  }

  events.push(await logJobEvent(admin, {
    job_id: payload.job_id,
    event_type: "pipeline_succeeded",
    step: "pipeline",
    status: finalJob.data.status as "succeeded" | "needs_review",
    request_id: requestId,
    metadata: {
      classification_id: classification.data?.id ?? null,
    },
  }));

  return {
    success: true,
    job_id: payload.job_id,
    status: String(finalJob.data.status),
    current_step: String(finalJob.data.current_step),
    classification_id: classification.data?.id ?? null,
    request_id: requestId,
    events,
  };
}
