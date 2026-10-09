import type { CanonicalRpc } from "./canonical_transport.ts";
import type { CanonicalJob, WorkerBoundary } from "./canonical_worker.ts";
import { enrichCanonicalText } from "./canonical_enrichment.ts";
import { fetchResourceMetadata } from "./v3_youtube.ts";
import { acquireCanonicalYoutube } from "./canonical_ingestion.ts";
import { HttpError } from "./http.ts";

export function canonicalBoundary(rpc: CanonicalRpc, enrichmentKey: string | null,
  runtime: "edge" | "isolated" = "edge"): WorkerBoundary {
  return {
    runtime,
    claim: async () => await (runtime === "edge" ? rpc("facodi_canonical_claim") :
      rpc("facodi_canonical_claim_for_runtime", { p_runtime: runtime })) as CanonicalJob | null,
    checkpoint: async (job, key, value) => {
      await rpc("facodi_canonical_checkpoint", {
        p_job_id: job.id, p_token: job.claim_token, p_key: key, p_value: value,
      });
    },
    finish: async (job, status, result) => await rpc("facodi_canonical_finish", {
      p_job_id: job.id, p_token: job.claim_token, p_status: status, p_result: result,
    }),
    metadata: async (request) => request.acquisition_config ? await acquireCanonicalYoutube(request) : await fetchResourceMetadata(request.source_url, {
      provider: request.source_type, title: request.title, language: request.language,
    }),
    analyze: async (_metadata, request) => {
      const key = request.provider_config.provider === "gemini" ? enrichmentKey : null;
      if (request.provider_config.provider === "gemini" && !key) throw new HttpError(503, "accepted_provider_unavailable");
      return await enrichCanonicalText(request, key);
    },
  };
}