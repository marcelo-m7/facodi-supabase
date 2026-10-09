import { HttpError } from "./http.ts";
import { extractYouTubeVideoId, type ResourceMetadata } from "./v3_youtube.ts";
import type { EnrichedText, TextChunk } from "./canonical_enrichment.ts";
import { mapAcceptedCatalog, validateAcceptedCatalog, verifyAcceptedCatalog, type AcceptedCatalog } from "./canonical_mapping.ts";

export interface CanonicalRequest {
  source_type: "manual" | "markdown" | "youtube";
  source_url: string;
  title: string;
  raw_content: string;
  language: string;
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
  metadata(request: CanonicalRequest): Promise<ResourceMetadata>;
  analyze(metadata: ResourceMetadata, request: CanonicalRequest): Promise<AnalysisCheckpoint>;
}

export function validateCanonicalRequest(value: unknown, companyId?: number): CanonicalRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_canonical_request");
  }
  const request = value as CanonicalRequest;
  const allowed = new Set(["source_type", "source_url", "title", "raw_content", "language", "provider_config", "catalog_snapshot"]);
  if (Object.keys(request).some((key) => !allowed.has(key)) ||
      !["manual", "markdown", "youtube"].includes(request.source_type) ||
      [request.source_url, request.title, request.raw_content, request.language].some((field) => typeof field !== "string") ||
      request.title.length > 256 || request.language.length > 20 || request.source_url.length > 2048 ||
      new TextEncoder().encode(JSON.stringify(request)).length > 60000 ||
      new TextEncoder().encode(request.raw_content).length > 12000 ||
      !request.raw_content.trim()) {
    throw new HttpError(400, "invalid_canonical_request");
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
  let metadata = job.checkpoint.metadata as ResourceMetadata | undefined;
  if (!metadata) {
    metadata = await boundary.metadata(request);
    if (new TextEncoder().encode(JSON.stringify(metadata)).length > 60000) {
      return await boundary.finish(job, "failed", { error_code: "OUTPUT_BUDGET_EXHAUSTED" });
    }
    await boundary.checkpoint(job, "metadata", metadata);
  }
  let analysis = job.checkpoint.analysis as AnalysisCheckpoint | undefined;
  if (!analysis) {
    if (!Number.isFinite(Date.parse(job.lease_until)) || Date.parse(job.lease_until) - Date.now() < 75000) {
      throw new HttpError(503, "INSUFFICIENT_LEASE_BUDGET");
    }
    analysis = await boundary.analyze(metadata, request);
    if (request.catalog_snapshot) {
      analysis.enriched_data = { ...analysis.enriched_data, id: crypto.randomUUID() };
      analysis.mapping_data = mapAcceptedCatalog(analysis.enriched_data, request.catalog_snapshot, analysis.enriched_data.id!);
    }
    if (new TextEncoder().encode(JSON.stringify(analysis)).length > 60000) {
      return await boundary.finish(job, "failed", { error_code: "OUTPUT_BUDGET_EXHAUSTED" });
    }
    await boundary.checkpoint(job, "analysis", analysis);
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