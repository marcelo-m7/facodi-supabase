import { createClient } from "https://esm.sh/@supabase/supabase-js@2.105.4";
import {
  ensureMethod,
  HttpError,
  json,
  readJson,
  withHttp,
} from "./http.ts";
import { requireSecretApiKey } from "./v3_auth.ts";
import {
  canonicalYouTubeUrl,
  extractYouTubeVideoId,
  fetchResourceMetadata,
  type ResourceMetadata,
} from "./v3_youtube.ts";

interface VideoIngestRequest {
  idempotency_key?: string;
  source_url?: string;
  url?: string;
  video_id?: string;
  title?: string;
  description?: string;
  language?: string;
  channel_id?: string | number;
  metadata?: Record<string, unknown>;
  odoo?: Record<string, unknown>;
}

interface ProcessingJobRow {
  id: string;
  idempotency_key: string;
  status: string;
  metadata: Record<string, unknown>;
  provider_name: string | null;
  model_name: string | null;
  prompt_version: string | null;
}

interface VideoIngestOptions {
  mechanism: string;
  compatibility_alias?: string;
}

function textValue(value: unknown, max = 4096): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().slice(0, max);
}

function positiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredYouTubeIdentity(body: VideoIngestRequest): {
  sourceUrl: string;
  videoId: string;
} {
  const candidate =
    textValue(body.source_url, 4096) ??
    textValue(body.url, 4096) ??
    textValue(body.video_id, 64);

  if (!candidate) {
    throw new HttpError(
      400,
      "invalid_request",
      "A YouTube source_url, url, or video_id is required.",
    );
  }

  const videoId = extractYouTubeVideoId(candidate);
  if (!videoId) {
    throw new HttpError(
      400,
      "invalid_youtube_url",
      "The video ingest mechanism only accepts public YouTube video URLs or IDs.",
    );
  }

  const declaredVideoId = textValue(body.video_id, 64);
  if (declaredVideoId && declaredVideoId !== videoId) {
    throw new HttpError(
      409,
      "video_identity_mismatch",
      "video_id does not match the supplied YouTube URL.",
    );
  }

  return {
    sourceUrl: canonicalYouTubeUrl(videoId),
    videoId,
  };
}

function normalizedOdooContext(body: VideoIngestRequest) {
  const metadata = recordValue(body.metadata);
  const odoo = recordValue(body.odoo);

  const slideId =
    positiveInt(odoo.slide_id) ??
    positiveInt(metadata.odoo_slide_id);
  const channelId =
    positiveInt(odoo.channel_id) ??
    positiveInt(metadata.odoo_channel_id) ??
    positiveInt(body.channel_id);
  const model =
    textValue(odoo.model, 128) ??
    textValue(metadata.source_model, 128) ??
    (slideId ? "slide.slide" : null);
  const resId =
    positiveInt(odoo.res_id) ??
    positiveInt(metadata.odoo_res_id) ??
    slideId;

  return {
    model,
    resId,
    slideId,
    channelId,
  };
}

function stableIdempotencyKey(
  body: VideoIngestRequest,
  videoId: string,
  slideId: number | null,
): string {
  const explicit = textValue(body.idempotency_key, 255);
  if (explicit) return explicit;

  if (slideId) {
    return `video-ingest:odoo-slide:${slideId}:${videoId}`;
  }
  return `video-ingest:youtube:${videoId}`;
}

function responsePayload(
  row: ProcessingJobRow,
  metadata: ResourceMetadata,
  options: VideoIngestOptions,
  replay: boolean,
) {
  const compactMetadata = {
    provider: metadata.provider,
    external_id: metadata.external_id,
    canonical_url: metadata.canonical_url,
    title: metadata.title?.slice(0, 500) ?? null,
    description: metadata.description?.slice(0, 4000) ?? null,
    author_name: metadata.author_name?.slice(0, 300) ?? null,
    author_url: metadata.author_url,
    thumbnail_url: metadata.thumbnail_url,
    duration_seconds: metadata.duration_seconds,
    published_at: metadata.published_at,
    language: metadata.language?.slice(0, 32) ?? null,
    metadata_source: metadata.metadata_source,
  };

  return {
    success: true,
    replay,
    mechanism: options.mechanism,
    compatibility_alias: options.compatibility_alias ?? null,
    job_id: row.id,
    idempotency_key: row.idempotency_key,
    status: row.status,
    provider: "youtube",
    video_id: metadata.external_id,
    external_id: metadata.external_id,
    canonical_url: metadata.canonical_url,
    metadata: compactMetadata,
    provider_name: row.provider_name,
    model_name: row.model_name,
    prompt_version: row.prompt_version,
  };
}

export function handleVideoIngest(
  req: Request,
  options: VideoIngestOptions,
): Promise<Response> {
  return withHttp(req, async () => {
    ensureMethod(req, "POST");
    const secretKey = requireSecretApiKey(req);
    const parsed = await readJson<VideoIngestRequest | null>(req);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(
        400,
        "invalid_request",
        "Request body must be a JSON object.",
      );
    }

    const body = parsed as VideoIngestRequest;
    const { sourceUrl, videoId } = requiredYouTubeIdentity(body);
    const odoo = normalizedOdooContext(body);
    const idempotencyKey = stableIdempotencyKey(body, videoId, odoo.slideId);

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
        "id,idempotency_key,status,metadata,provider_name,model_name,prompt_version",
      )
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle<ProcessingJobRow>();

    if (existing.error) {
      throw new HttpError(500, "supabase_error", existing.error.message);
    }

    if (existing.data?.status === "completed") {
      return json(
        responsePayload(
          existing.data,
          existing.data.metadata as unknown as ResourceMetadata,
          options,
          true,
        ),
      );
    }

    let jobId = existing.data?.id ?? null;
    if (jobId) {
      const updated = await admin
        .from("facodi_processing_jobs")
        .update({
          status: "processing",
          source_url: sourceUrl,
          provider: "youtube",
          external_id: videoId,
          odoo_model: odoo.model,
          odoo_res_id: odoo.resId,
          odoo_slide_id: odoo.slideId,
          odoo_channel_id: odoo.channelId,
          request_payload: body,
          error_code: null,
          error_message: null,
          completed_at: null,
          updated_at: new Date().toISOString(),
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
          provider: "youtube",
          external_id: videoId,
          odoo_model: odoo.model,
          odoo_res_id: odoo.resId,
          odoo_slide_id: odoo.slideId,
          odoo_channel_id: odoo.channelId,
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
        provider: "youtube",
        external_id: videoId,
        title: textValue(body.title, 500),
        description: textValue(body.description, 12000),
        language: textValue(body.language, 32),
      });

      if (metadata.provider !== "youtube" || metadata.external_id !== videoId) {
        throw new HttpError(
          502,
          "youtube_identity_unverified",
          "YouTube metadata did not preserve the expected video identity.",
        );
      }

      const completedAt = new Date().toISOString();
      const saved = await admin
        .from("facodi_processing_jobs")
        .update({
          source_url: metadata.canonical_url,
          provider: "youtube",
          external_id: videoId,
          status: "completed",
          metadata,
          analysis: {},
          provider_name: "supabase_edge",
          model_name: "youtube-metadata-v1",
          prompt_version: "facodi-video-ingest-v3",
          error_code: null,
          error_message: null,
          completed_at: completedAt,
          updated_at: completedAt,
        })
        .eq("id", jobId)
        .select(
          "id,idempotency_key,status,metadata,provider_name,model_name,prompt_version",
        )
        .single<ProcessingJobRow>();

      if (saved.error) {
        throw new HttpError(500, "supabase_error", saved.error.message);
      }

      return json(responsePayload(saved.data, metadata, options, false));
    } catch (error) {
      const code = error instanceof HttpError ? error.code : "unexpected_error";
      const message =
        error instanceof Error
          ? error.message.slice(0, 1000)
          : "Unexpected video-ingest error.";
      const failedAt = new Date().toISOString();
      const failed = await admin
        .from("facodi_processing_jobs")
        .update({
          status: "failed",
          error_code: code,
          error_message: message,
          completed_at: failedAt,
          updated_at: failedAt,
        })
        .eq("id", jobId);

      if (failed.error) {
        console.error("FACODI video ingest failure evidence could not be persisted", {
          processing_job_id: jobId,
          original_error: error,
          persistence_error: failed.error,
        });
        throw new HttpError(
          500,
          "supabase_error",
          "Video-ingest failure evidence could not be persisted.",
        );
      }

      throw new HttpError(
        error instanceof HttpError ? error.status : 500,
        code,
        "YouTube video ingest failed.",
        { processing_job_id: jobId },
      );
    }
  });
}
