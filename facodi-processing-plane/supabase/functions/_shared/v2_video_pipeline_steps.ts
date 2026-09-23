import { HttpError } from "./v2_http.ts";
import { loadJobContext, updateJob } from "./v2_jobs.ts";
import {
  assignPlaylistDeterministically,
  type FacodiPlaylistCandidate,
} from "./v2_playlist_assignment.ts";
import { normalizeWhitespace, sha256Hex } from "./v2_text.ts";
import type { AdminClient } from "./v2_supabase.ts";
import { facodi, unwrap, unwrapMaybe } from "./v2_supabase.ts";
import { fetchYouTubeMetadata } from "./v2_youtube.ts";

export interface StagePayload {
  job_id?: string;
  video_id?: string;
  youtube_video_id?: string;
  match_count?: number;
}

async function upsertArtifact(
  db: ReturnType<typeof facodi>,
  row: Record<string, unknown>,
): Promise<void> {
  const existing = await db
    .from("video_artifacts")
    .select("id")
    .eq("video_id", row.video_id as string)
    .eq("artifact_type", row.artifact_type as string)
    .eq("source", row.source as string)
    .maybeSingle();
  if (existing.error) throw new HttpError(500, "supabase_error", existing.error.message);
  const result = existing.data
    ? await db.from("video_artifacts").update(row).eq("id", existing.data.id)
    : await db.from("video_artifacts").insert(row);
  if (result.error) throw new HttpError(500, "supabase_error", result.error.message);
}

async function upsertCandidate(
  db: ReturnType<typeof facodi>,
  row: Record<string, unknown>,
): Promise<void> {
  let query = db
    .from("classification_candidates")
    .select("id")
    .eq("job_id", row.job_id as string)
    .eq("candidate_type", row.candidate_type as string)
    .eq("course_id", row.course_id as string);

  if (row.curricular_unit_id) {
    query = query.eq("curricular_unit_id", row.curricular_unit_id as string);
  } else {
    query = query.is("curricular_unit_id", null);
  }

  const existing = unwrapMaybe<{ id: string }>(await query.maybeSingle());
  const result = existing
    ? await db.from("classification_candidates").update(row).eq("id", existing.id)
    : await db.from("classification_candidates").insert(row);
  if (result.error) throw new HttpError(500, "supabase_error", result.error.message);
}

export async function runFetchYoutubeMetadata(
  admin: AdminClient,
  payload: StagePayload,
): Promise<Record<string, unknown>> {
  const { job, video } = await loadJobContext(admin, payload);
  const db = facodi(admin);
  const metadata = await fetchYouTubeMetadata(video.youtube_video_id as string);
  const updateResult = await db
    .from("youtube_videos")
    .update({ ...metadata, status: "metadata_ready" })
    .eq("id", video.id as string);
  if (updateResult.error) throw new HttpError(500, "supabase_error", updateResult.error.message);

  const text = normalizeWhitespace([metadata.title, metadata.description, metadata.tags.join(" ")].join("\n"));
  await upsertArtifact(db, {
    video_id: video.id,
    artifact_type: "metadata",
    content_json: metadata,
    content_text: metadata.title,
    language: metadata.language,
    source: "youtube_api",
    content_hash: await sha256Hex(JSON.stringify(metadata)),
    metadata: { source: "youtube_public", fetched_with_youtube_public: true },
  });

  if (text.length > 0) {
    await upsertArtifact(db, {
      video_id: video.id,
      artifact_type: "description",
      content_json: {},
      content_text: text,
      language: metadata.language,
      source: "youtube_api",
      content_hash: await sha256Hex(text),
      metadata: { source: "youtube_public" },
    });
  }

  await updateJob(admin, job.id as string, {
    status: "running",
    current_step: "metadata_ready",
    result_payload: { metadata_ready: true, source: "youtube_public" },
  });

  return {
    success: true,
    job_id: job.id,
    video_id: video.id,
    youtube_video_id: metadata.youtube_video_id,
    source: "youtube_public",
  };
}

export async function runExtractVideoContent(
  admin: AdminClient,
  payload: StagePayload,
): Promise<Record<string, unknown>> {
  const { job, video } = await loadJobContext(admin, payload);
  const db = facodi(admin);
  const artifacts = await db
    .from("video_artifacts")
    .select("artifact_type, content_text")
    .eq("video_id", video.id as string)
    .in("artifact_type", ["description", "transcript", "captions", "chapters"]);
  if (artifacts.error) throw new HttpError(500, "supabase_error", artifacts.error.message);

  const text = normalizeWhitespace([
    video.title,
    video.description,
    Array.isArray(video.tags) ? (video.tags as string[]).join(" ") : "",
    ...(artifacts.data ?? []).map(
      (artifact: { content_text?: string | null }) => artifact.content_text ?? "",
    ),
  ].join("\n\n"));

  if (text.length === 0) {
    await updateJob(admin, job.id as string, {
      status: "running",
      current_step: "content_limited",
      result_payload: { clean_text_chars: 0, source: "youtube_public" },
    });
    return { success: true, job_id: job.id, video_id: video.id, clean_text_chars: 0 };
  }

  await upsertArtifact(db, {
    video_id: video.id,
    artifact_type: "clean_text",
    content_text: text,
    content_json: {},
    language: video.language ?? "pt",
    source: "system",
    content_hash: await sha256Hex(text),
    metadata: { generated_from: ["metadata", "description", "transcript", "captions", "chapters"] },
  });

  const videoUpdate = await db.from("youtube_videos").update({ status: "content_ready" }).eq("id", video.id as string);
  if (videoUpdate.error) throw new HttpError(500, "supabase_error", videoUpdate.error.message);
  await updateJob(admin, job.id as string, {
    status: "running",
    current_step: "content_ready",
    result_payload: { clean_text_chars: text.length, source: "youtube_public" },
  });

  return { success: true, job_id: job.id, video_id: video.id, clean_text_chars: text.length };
}

export async function runMatchVideoCandidates(
  admin: AdminClient,
  payload: StagePayload,
): Promise<Record<string, unknown>> {
  const { job, video } = await loadJobContext(admin, payload);
  const db = facodi(admin);
  const playlists = await db
    .from("v_catalog_playlists")
    .select("id,title,slug,description,course_id,course_code,unit_id,unit_code,video_count")
    .limit(1000);
  if (playlists.error) throw new HttpError(500, "supabase_error", playlists.error.message);

  const assignment = assignPlaylistDeterministically({
    youtube_video_id: video.youtube_video_id as string,
    title: video.title as string | null,
    description: video.description as string | null,
    channel_title: video.channel_title as string | null,
    tags: Array.isArray(video.tags) ? video.tags as string[] : [],
  }, (playlists.data ?? []) as FacodiPlaylistCandidate[]);

  let rank = 1;
  for (const candidate of assignment.top_candidates) {
    await upsertCandidate(db, {
      job_id: job.id,
      video_id: video.id,
      course_id: candidate.course_id,
      curricular_unit_id: candidate.curricular_unit_id,
      candidate_type: "curricular_unit",
      rank: rank++,
      keyword_score: candidate.confidence,
      combined_score: candidate.confidence,
      confidence: candidate.confidence,
      justification: `Playlist sugerida: ${candidate.playlist_title}`,
      evidence: [{ source: "deterministic_playlist_assignment", signals: candidate.signals }],
      metadata: {
        decision_source: assignment.decision_source,
        playlist_id: candidate.playlist_id,
        playlist_slug: candidate.playlist_slug,
        playlist_title: candidate.playlist_title,
        course_code: candidate.course_code,
        unit_code: candidate.unit_code,
        algorithm_version: assignment.algorithm_version,
        signals: candidate.signals,
      },
    });
  }

  await updateJob(admin, job.id as string, {
    status: "running",
    current_step: "candidates_ready",
    result_payload: {
      source: "deterministic_playlist_assignment",
      candidates: assignment.top_candidates.length,
      top_candidate: assignment.top_candidates[0] ?? null,
    },
  });

  return {
    success: true,
    job_id: job.id,
    candidates: assignment.top_candidates.length,
    assignment,
  };
}

export async function runClassifyVideo(
  admin: AdminClient,
  payload: StagePayload,
): Promise<Record<string, unknown>> {
  const { job, video } = await loadJobContext(admin, payload);
  const db = facodi(admin);
  const candidates = await db
    .from("classification_candidates")
    .select("*")
    .eq("job_id", job.id as string)
    .order("rank", { ascending: true })
    .limit(10);
  if (candidates.error) throw new HttpError(500, "supabase_error", candidates.error.message);

  const best = (candidates.data ?? [])[0] as Record<string, unknown> | undefined;
  const metadata = (best?.metadata ?? {}) as Record<string, unknown>;
  const confidence = Math.max(0, Math.min(Number(best?.confidence ?? 0), 1));
  const now = new Date().toISOString();
  const row = {
    job_id: job.id,
    video_id: video.id,
    course_id: best?.course_id ?? null,
    curricular_unit_id: best?.curricular_unit_id ?? null,
    model_run_id: null,
    confidence,
    confidence_level: confidence >= 0.78 ? "high" : confidence >= 0.55 ? "medium" : "low",
    status: "needs_review",
    needs_review: true,
    justification: best?.justification ?? "Classificação determinística pendente de revisão editorial.",
    evidence: best?.evidence ?? [],
    reviewed_by: null,
    reviewed_at: null,
    metadata: {
      decision_source: "deterministic",
      source: "youtube_public",
      playlist_id: metadata.playlist_id ?? null,
      playlist_slug: metadata.playlist_slug ?? null,
      playlist_title: metadata.playlist_title ?? null,
      algorithm_version: metadata.algorithm_version ?? null,
      signals: metadata.signals ?? [],
      top_candidates: candidates.data ?? [],
    },
  };

  const existing = unwrapMaybe<{ id: string }>(
    await db.from("video_classifications").select("id").eq("job_id", job.id as string).maybeSingle(),
  );
  const classification = unwrap<{ id: string }>(
    existing
      ? await db.from("video_classifications").update(row).eq("id", existing.id).select("id").single()
      : await db.from("video_classifications").insert(row).select("id").single(),
  );

  const videoUpdate = await db.from("youtube_videos").update({ status: "classified" }).eq("id", video.id as string);
  if (videoUpdate.error) throw new HttpError(500, "supabase_error", videoUpdate.error.message);
  await updateJob(admin, job.id as string, {
    status: "needs_review",
    current_step: "classified",
    error_code: null,
    error_message: null,
    completed_at: now,
    result_payload: {
      classification_id: classification.id,
      course_id: row.course_id,
      curricular_unit_id: row.curricular_unit_id,
      confidence,
      needs_review: true,
      decision_source: "deterministic",
      playlist_id: row.metadata.playlist_id,
      playlist_slug: row.metadata.playlist_slug,
      playlist_title: row.metadata.playlist_title,
    },
  });

  return {
    success: true,
    job_id: job.id,
    classification_id: classification.id,
    course_id: row.course_id,
    curricular_unit_id: row.curricular_unit_id,
    confidence,
    needs_review: true,
    decision_source: "deterministic",
    playlist_id: row.metadata.playlist_id,
    playlist_slug: row.metadata.playlist_slug,
    playlist_title: row.metadata.playlist_title,
  };
}

export async function runPipelineStage(
  admin: AdminClient,
  stage: string,
  payload: StagePayload,
): Promise<Record<string, unknown>> {
  if (stage === "v2_fetch_youtube_metadata") return await runFetchYoutubeMetadata(admin, payload);
  if (stage === "v2_extract_video_content") return await runExtractVideoContent(admin, payload);
  if (stage === "v2_match_video_candidates") return await runMatchVideoCandidates(admin, payload);
  if (stage === "v2_classify_video") return await runClassifyVideo(admin, payload);
  if (stage === "v2_generate_embeddings") {
    await updateJob(admin, payload.job_id as string, {
      status: "running",
      current_step: "embeddings_skipped",
      result_payload: { embeddings_optional: true, skipped: true },
    });
    return { success: true, embeddings_optional: true, skipped: true };
  }
  throw new HttpError(400, "invalid_pipeline_stage", `Invalid pipeline stage: ${stage}`);
}
