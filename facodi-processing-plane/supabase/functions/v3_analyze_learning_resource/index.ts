import { createClient } from "https://esm.sh/@supabase/supabase-js@2.105.4";
import {
  ensureMethod,
  HttpError,
  json,
  readJson,
  withHttp,
} from "../_shared/v2_http.ts";
import {
  optionalGeminiApiKey,
  requireSecretApiKey,
} from "../_shared/v3_auth.ts";
import { analyzeLearningResource } from "../_shared/v3_gemini.ts";
import {
  fetchResourceMetadata,
  type ResourceMetadata,
} from "../_shared/v3_youtube.ts";

interface OdooContext {
  model?: string;
  res_id?: number;
  analysis_job_id?: number;
  slide_id?: number;
  channel_id?: number;
  curriculum_unit_id?: number;
  title?: string;
  description?: string;
  transcript?: string;
  language?: string;
}

interface AnalyzeRequest {
  idempotency_key: string;
  source_url: string;
  provider_hint?: string;
  external_id?: string;
  odoo?: OdooContext;
}

interface ProcessingJobRow {
  id: string;
  idempotency_key: string;
  status: string;
  metadata: Record<string, unknown>;
  analysis: Record<string, unknown>;
  model_name: string | null;
  prompt_version: string | null;
  provider_name: string | null;
}

function requiredText(value: unknown, name: string, max = 4096): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "invalid_request", `${name} is required.`);
  }
  return value.trim().slice(0, max);
}

function publicHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (_error) {
    throw new HttpError(400, "invalid_source_url", "source_url must be a valid URL.");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    throw new HttpError(
      400,
      "invalid_source_url",
      "source_url must use HTTP or HTTPS.",
    );
  }
  if (url.username || url.password) {
    throw new HttpError(
      400,
      "invalid_source_url",
      "source_url must not contain credentials.",
    );
  }
  return url.toString();
}

function normalizeOdooContext(value: unknown): OdooContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const number = (key: string): number | undefined =>
    Number.isInteger(source[key]) && Number(source[key]) > 0
      ? Number(source[key])
      : undefined;
  const text = (key: string, max: number): string | undefined =>
    typeof source[key] === "string" && String(source[key]).trim()
      ? String(source[key]).trim().slice(0, max)
      : undefined;

  return {
    model: text("model", 128),
    res_id: number("res_id"),
    analysis_job_id: number("analysis_job_id"),
    slide_id: number("slide_id"),
    channel_id: number("channel_id"),
    curriculum_unit_id: number("curriculum_unit_id"),
    title: text("title", 500),
    description: text("description", 12000),
    transcript: text("transcript", 50000),
    language: text("language", 32),
  };
}

function odooPayload(
  job: ProcessingJobRow,
  metadata: ResourceMetadata,
  analysis: Record<string, unknown>,
  transcript: string,
) {
  const summary =
    typeof analysis.summary === "string" ? analysis.summary : metadata.title ?? "";
  const detectedLanguage =
    typeof analysis.detected_language === "string"
      ? analysis.detected_language
      : metadata.language ?? false;
  const suggestedTags = Array.isArray(analysis.suggested_tags)
    ? analysis.suggested_tags.filter((value) => typeof value === "string")
    : [];

  return {
    summary,
    transcript,
    detected_language: detectedLanguage,
    suggested_tag_ids: [],
    suggested_tags: suggestedTags,
    proposed_mappings: [],
    model_name: job.model_name || "metadata-fallback-v1",
    raw_payload: {
      source: "supabase_edge",
      processing_job_id: job.id,
      idempotency_key: job.idempotency_key,
      provider_name: job.provider_name,
      prompt_version: job.prompt_version,
      metadata,
      analysis: {
        topics: analysis.topics ?? [],
        learning_objectives: analysis.learning_objectives ?? [],
        difficulty: analysis.difficulty ?? null,
        confidence: analysis.confidence ?? null,
        analysis_mode: analysis.analysis_mode ?? null,
      },
    },
  };
}

Deno.serve((req) =>
  withHttp(req, async () => {
    ensureMethod(req, "POST");
    const secretKey = requireSecretApiKey(req);
    const body = await readJson<AnalyzeRequest>(req);

    const idempotencyKey = requiredText(
      body.idempotency_key,
      "idempotency_key",
      255,
    );
    const sourceUrl = publicHttpUrl(requiredText(body.source_url, "source_url", 4096));
    const odoo = normalizeOdooContext(body.odoo);
    const transcript = odoo.transcript ?? "";

    const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
    if (!supabaseUrl) {
      throw new HttpError(
        500,
        "missing_environment",
        "SUPABASE_URL is not configured.",
      );
    }

    const admin = createClient(supabaseUrl, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { "x-application-name": "facodi-processing-v3" } },
    });

    const existing = await admin
      .from("facodi_processing_jobs")
      .select(
        "id,idempotency_key,status,metadata,analysis,model_name,prompt_version,provider_name",
      )
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle<ProcessingJobRow>();

    if (existing.error) {
      throw new HttpError(500, "supabase_error", existing.error.message);
    }

    if (
      existing.data &&
      ["completed", "needs_review"].includes(existing.data.status)
    ) {
      const metadata = existing.data.metadata as unknown as ResourceMetadata;
      return json({
        success: true,
        replay: true,
        job_id: existing.data.id,
        status: existing.data.status,
        metadata,
        analysis: existing.data.analysis,
        odoo_payload: odooPayload(
          existing.data,
          metadata,
          existing.data.analysis,
          transcript,
        ),
      });
    }

    let jobId = existing.data?.id ?? null;
    if (jobId) {
      const updated = await admin
        .from("facodi_processing_jobs")
        .update({
          status: "processing",
          error_code: null,
          error_message: null,
          updated_at: new Date().toISOString(),
          request_payload: body,
        })
        .eq("id", jobId);
      if (updated.error) {
        throw new HttpError(500, "supabase_error", updated.error.message);
      }
    } else {
      const inserted = await admin
        .from("facodi_processing_jobs")
        .insert({
          idempotency_key: idempotencyKey,
          source_url: sourceUrl,
          provider: body.provider_hint?.trim() || "generic",
          external_id: body.external_id?.trim() || null,
          odoo_model: odoo.model ?? null,
          odoo_res_id: odoo.res_id ?? null,
          odoo_analysis_job_id: odoo.analysis_job_id ?? null,
          odoo_slide_id: odoo.slide_id ?? null,
          odoo_channel_id: odoo.channel_id ?? null,
          curriculum_unit_id: odoo.curriculum_unit_id ?? null,
          status: "processing",
          request_payload: body,
        })
        .select("id")
        .single<{ id: string }>();
      if (inserted.error) {
        const replay = await admin
          .from("facodi_processing_jobs")
          .select("id")
          .eq("idempotency_key", idempotencyKey)
          .maybeSingle<{ id: string }>();
        if (replay.error || !replay.data) {
          throw new HttpError(500, "supabase_error", inserted.error.message);
        }
        jobId = replay.data.id;
      } else {
        jobId = inserted.data.id;
      }
    }

    try {
      const metadata = await fetchResourceMetadata(sourceUrl, {
        provider: body.provider_hint || "generic",
        external_id: body.external_id || null,
        title: odoo.title || null,
        description: odoo.description || null,
        language: odoo.language || null,
      });

      const analyzed = await analyzeLearningResource(
        metadata,
        transcript,
        optionalGeminiApiKey(req),
      );

      const status = "needs_review";
      const completedAt = new Date().toISOString();
      const saved = await admin
        .from("facodi_processing_jobs")
        .update({
          source_url: metadata.canonical_url,
          provider: metadata.provider,
          external_id: metadata.external_id,
          status,
          metadata,
          analysis: analyzed.analysis,
          provider_name: "supabase_edge",
          model_name: analyzed.model_name,
          prompt_version: analyzed.prompt_version,
          error_code: null,
          error_message: null,
          updated_at: completedAt,
          completed_at: completedAt,
        })
        .eq("id", jobId)
        .select(
          "id,idempotency_key,status,metadata,analysis,model_name,prompt_version,provider_name",
        )
        .single<ProcessingJobRow>();

      if (saved.error) {
        throw new HttpError(500, "supabase_error", saved.error.message);
      }

      return json({
        success: true,
        replay: false,
        job_id: saved.data.id,
        status: saved.data.status,
        metadata,
        analysis: analyzed.analysis,
        odoo_payload: odooPayload(
          saved.data,
          metadata,
          analyzed.analysis as unknown as Record<string, unknown>,
          transcript,
        ),
      });
    } catch (error) {
      const code = error instanceof HttpError ? error.code : "unexpected_error";
      const message =
        error instanceof Error ? error.message.slice(0, 1000) : "Unexpected processing error.";
      const failed = await admin
        .from("facodi_processing_jobs")
        .update({
          status: "failed",
          error_code: code,
          error_message: message,
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        })
        .eq("id", jobId);

      if (failed.error) {
        console.error("FACODI analysis failure evidence could not be persisted", {
          processing_job_id: jobId,
          original_error: error,
          persistence_error: failed.error,
        });
        throw new HttpError(
          500,
          "supabase_error",
          "Learning-resource failure evidence could not be persisted.",
        );
      }

      const status = error instanceof HttpError ? error.status : 500;
      throw new HttpError(
        status,
        code,
        "Learning-resource analysis failed.",
        {
          processing_job_id: jobId,
        },
      );
    }
  })
);
