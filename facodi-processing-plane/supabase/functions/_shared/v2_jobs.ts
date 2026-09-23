import type { AdminClient } from "./v2_supabase.ts";
import { facodi, unwrap, unwrapMaybe } from "./v2_supabase.ts";
import { HttpError } from "./v2_http.ts";

export interface JobContext {
  job: Record<string, unknown>;
  video: Record<string, unknown>;
}

export async function loadJobContext(
  admin: AdminClient,
  payload: { job_id?: string; video_id?: string; youtube_video_id?: string },
): Promise<JobContext> {
  const db = facodi(admin);
  let job: Record<string, unknown> | null = null;
  let video: Record<string, unknown> | null = null;

  if (payload.job_id) {
    job = unwrap<Record<string, unknown>>(
      await db.from("analysis_jobs").select("*").eq("id", payload.job_id).maybeSingle(),
    );
    const videoId = job.video_id as string | null;
    if (videoId) {
      video = unwrap<Record<string, unknown>>(
        await db.from("youtube_videos").select("*").eq("id", videoId).maybeSingle(),
      );
    }
  } else if (payload.video_id) {
    video = unwrap<Record<string, unknown>>(
      await db.from("youtube_videos").select("*").eq("id", payload.video_id).maybeSingle(),
    );
  } else if (payload.youtube_video_id) {
    video = unwrap<Record<string, unknown>>(
      await db
        .from("youtube_videos")
        .select("*")
        .eq("youtube_video_id", payload.youtube_video_id)
        .maybeSingle(),
    );
  }

  if (!video) {
    throw new HttpError(404, "video_not_found", "YouTube video was not found.");
  }

  if (!job) {
    job = unwrapMaybe<Record<string, unknown>>(
      await db
        .from("analysis_jobs")
        .select("*")
        .eq("video_id", video.id as string)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    );
  }

  if (!job) {
    job = unwrap<Record<string, unknown>>(
      await db
        .from("analysis_jobs")
        .insert({
          video_id: video.id,
          youtube_video_id: video.youtube_video_id,
          input_url: video.canonical_url,
          status: "queued",
          current_step: "created",
        })
        .select("*")
        .single(),
    );
  }

  return { job, video };
}

export async function updateJob(
  admin: AdminClient,
  jobId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const result = await facodi(admin).from("analysis_jobs").update(patch).eq("id", jobId);
  if (result.error) {
    throw new HttpError(500, "supabase_error", result.error.message);
  }
}

export async function failJob(
  admin: AdminClient,
  jobId: string | null | undefined,
  error: unknown,
): Promise<void> {
  if (!jobId) {
    return;
  }
  await updateJob(admin, jobId, {
    status: "failed",
    error_code: error instanceof HttpError ? error.code : "unexpected_error",
    error_message: error instanceof Error ? error.message : "Unexpected server error.",
    completed_at: new Date().toISOString(),
  });
}
