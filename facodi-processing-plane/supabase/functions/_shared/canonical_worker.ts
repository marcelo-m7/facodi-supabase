import { HttpError } from "./http.ts";
import { extractYouTubeVideoId, type ResourceMetadata } from "./v3_youtube.ts";
import type { EnrichedText, TextChunk } from "./canonical_enrichment.ts";
import { mapAcceptedCatalog, validateAcceptedCatalog, verifyAcceptedCatalog, type AcceptedCatalog } from "./canonical_mapping.ts";
import type { AcquiredMetadata } from "./canonical_ingestion.ts";

export interface CanonicalRequest {
  source_type: "manual" | "markdown" | "youtube";
  source_url: string;
  title: string;
  raw_content: string;
  language: string;
  acquisition_config?: { provider: "youtube-transcript-plus"; version: "2.0.3" };
  catalog_snapshot?: AcceptedCatalog;
  provider_config: { provider: "baseline" | "gemini"; version: string; model?: string; max_output_tokens?: number };
}

export interface CanonicalJob {
  id: string;
  task_ref: string;
  company_id: number;
  cohort: string;
  attempt: number;
  analysis_attempt_limit?: number;
  claim_token: string;
  lease_until: string;
  request_payload: CanonicalRequest;
  checkpoint: Record<string, unknown>;
}

export interface AnalysisCheckpoint {
  enriched_data: EnrichedText;
  chunks: TextChunk[];
  document_data: { text_content: string; language: string };
  mapping_data?: ReturnType<typeof mapAcceptedCatalog>;
}

export interface WorkerBoundary {
  claim(): Promise<CanonicalJob | null>;
  checkpoint(job: CanonicalJob, key: string, value: unknown): Promise<void>;
  finish(job: CanonicalJob, status: "needs_review" | "failed", result: unknown): Promise<unknown>;
  metadata(request: CanonicalRequest): Promise<AcquiredMetadata>;
  analyze(metadata: ResourceMetadata, request: CanonicalRequest): Promise<AnalysisCheckpoint>;
}

export function validateCanonicalRequest(value: unknown, companyId?: number): CanonicalRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_canonical_request");
  }
  const request = value as CanonicalRequest;
  const allowed = new Set(["source_type", "source_url", "title", "raw_content", "language", "provider_config", "catalog_snapshot", "acquisition_config"]);
  if (Object.keys(request).some((key) => !allowed.has(key)) ||
      !["manual", "markdown", "youtube"].includes(request.source_type) ||
      [request.source_url, request.title, request.raw_content, request.language].some((field) => typeof field !== "string") ||
      request.title.length > 256 || request.language.length > 20 || request.source_url.length > 2048 ||
      new TextEncoder().encode(JSON.stringify(request)).length > 60000 ||
      new TextEncoder().encode(request.raw_content).length > 12000 ||
      (!request.raw_content.trim() && (request.source_type !== "youtube" || !request.acquisition_config))) {
    throw new HttpError(400, "invalid_canonical_request");
  }
  if (request.acquisition_config !== undefined) {
    const acquisition = request.acquisition_config;
    if (!acquisition || typeof acquisition !== "object" || Array.isArray(acquisition) ||
        acquisition.provider !== "youtube-transcript-plus" || acquisition.version !== "2.0.3" ||
        Object.keys(acquisition).some((key) => !["provider", "version"].includes(key)) ||
        request.source_type !== "youtube" || request.raw_content.trim()) {
      throw new HttpError(400, "invalid_accepted_acquisition");
    }
  }
  const provider = request.provider_config;
  if (!provider || !["baseline", "gemini"].includes(provider.provider) ||
      Object.keys(provider).some((key) => !["provider", "version", "model", "max_output_tokens", "implementation", "max_attempts", "deadline_seconds"].includes(key)) ||
      (provider.provider === "baseline" && provider.version !== "regex-frequency-v2-evidence") ||
      (provider.provider === "gemini" &&
        (provider.version !== "gemini-chunk-evidence-v1" ||
          !provider.model || !/^gemini-[A-Za-z0-9_.-]{1,70}$/.test(provider.model) ||
          !Number.isInteger(provider.max_output_tokens) ||
          Number(provider.max_output_tokens) < 256 || Number(provider.max_output_tokens) > 8192))) {
    throw new HttpError(400, "invalid_accepted_provider");
  }
  if (request.source_type === "youtube") {
    let url: URL;
    try { url = new URL(request.source_url); }
    catch (_error) { throw new HttpError(400, "invalid_canonical_source"); }
    if (url.protocol !== "https:" || url.username || url.password || !extractYouTubeVideoId(request.source_url) ||
        !["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(url.hostname)) {
      throw new HttpError(400, "invalid_canonical_source");
    }
  } else if (request.source_url) {
    throw new HttpError(400, "invalid_canonical_source");
  }
  if (request.catalog_snapshot !== undefined) validateAcceptedCatalog(request.catalog_snapshot, companyId);
  return request;
}

export async function processCanonicalJob(boundary: WorkerBoundary): Promise<unknown> {
  const job = await boundary.claim();
  if (!job) return { idle: true };
  let request: CanonicalRequest;
  try {
    request = validateCanonicalRequest(job.request_payload, job.company_id);
    if (request.catalog_snapshot) await verifyAcceptedCatalog(request.catalog_snapshot);
  } catch (_error) {
    return await boundary.finish(job, "failed", { error_code: "INVALID_ACCEPTED_REQUEST" });
  }
  const analysisAttemptLimit = job.analysis_attempt_limit ?? 2;
  if (!Number.isSafeInteger(analysisAttemptLimit) || analysisAttemptLimit < 2 || analysisAttemptLimit > 20) {
    return await boundary.finish(job, "failed", { error_code: "INVALID_ATTEMPT_BUDGET" });
  }
  if (job.attempt > analysisAttemptLimit && !job.checkpoint.analysis) {
    return await boundary.finish(job, "failed", { error_code: "ATTEMPT_BUDGET_EXHAUSTED" });
  }
  let metadata = job.checkpoint.metadata as AcquiredMetadata | undefined;
  if (!metadata) {
    try {
      metadata = await boundary.metadata(request);
    } catch (error) {
      if (error instanceof HttpError && ["YOUTUBE_IP_BLOCKED", "YOUTUBE_TRANSCRIPTS_DISABLED",
          "YOUTUBE_LANGUAGE_UNAVAILABLE", "YOUTUBE_VIDEO_UNAVAILABLE", "CANONICAL_INPUT_CHANGED",
          "INPUT_BUDGET_EXHAUSTED"].includes(error.code)) {
        return await boundary.finish(job, "failed", { error_code: error.code });
      }
      throw error;
    }
    if (new TextEncoder().encode(JSON.stringify(metadata)).length > 60000) {
      return await boundary.finish(job, "failed", { error_code: "OUTPUT_BUDGET_EXHAUSTED" });
    }
    await boundary.checkpoint(job, "metadata", metadata);
  }
  let analysisRequest = request;
  if (request.acquisition_config) {
    const document = metadata.document_data;
    if (!document || typeof document.text_content !== "string" || !document.text_content.trim() ||
        new TextEncoder().encode(document.text_content).length > 12000 ||
        typeof document.language !== "string" || !document.language || document.language.length > 20 ||
        document.source_url !== request.source_url ||
        document.extraction_provider !== request.acquisition_config.provider ||
        document.extraction_version !== request.acquisition_config.version) {
      return await boundary.finish(job, "failed", { error_code: "INVALID_SOURCE_CHECKPOINT" });
    }
    analysisRequest = { ...request, raw_content: document.text_content, language: document.language };
  }
  let analysis = job.checkpoint.analysis as AnalysisCheckpoint | undefined;
  if (!analysis) {
    if (!Number.isFinite(Date.parse(job.lease_until)) || Date.parse(job.lease_until) - Date.now() < 75000) {
      throw new HttpError(503, "INSUFFICIENT_LEASE_BUDGET");
    }
    analysis = await boundary.analyze(metadata, analysisRequest);
    if (request.catalog_snapshot) {
      analysis.enriched_data = { ...analysis.enriched_data, id: crypto.randomUUID() };
      analysis.mapping_data = mapAcceptedCatalog(analysis.enriched_data, request.catalog_snapshot, analysis.enriched_data.id!);
    }
    if (new TextEncoder().encode(JSON.stringify(analysis)).length > 60000) {
      return await boundary.finish(job, "failed", { error_code: "OUTPUT_BUDGET_EXHAUSTED" });
    }
    await boundary.checkpoint(job, "analysis", analysis);
  }
  if (request.acquisition_config && (analysis.document_data.text_content !== analysisRequest.raw_content ||
      analysis.document_data.language !== analysisRequest.language)) {
    return await boundary.finish(job, "failed", { error_code: "INVALID_SOURCE_CHECKPOINT" });
  }
  const result = {
    metadata,
    ...analysis,
  };
  if (request.catalog_snapshot && (analysis.mapping_data?.snapshot_hash !== request.catalog_snapshot.snapshot_hash ||
      analysis.mapping_data?.snapshot_id !== request.catalog_snapshot.snapshot_id ||
      typeof analysis.enriched_data.id !== "string" || !analysis.enriched_data.id ||
      analysis.mapping_data?.enriched_document_id !== analysis.enriched_data.id ||
      analysis.mapping_data?.ranking_algorithm_version !== "deterministic-v2")) {
    return await boundary.finish(job, "failed", { error_code: "INVALID_MAPPING_CHECKPOINT" });
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > 60000) {
    return await boundary.finish(job, "failed", { error_code: "OUTPUT_BUDGET_EXHAUSTED" });
  }
  return await boundary.finish(job, "needs_review", result);
}