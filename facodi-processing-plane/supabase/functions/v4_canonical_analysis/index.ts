import { withSupabase } from "npm:@supabase/server@1.9.1";
import { canonicalTransport, type CanonicalRpc } from "../_shared/canonical_transport.ts";
import { processCanonicalJob, type CanonicalJob } from "../_shared/canonical_worker.ts";
import { enrichCanonicalText } from "../_shared/canonical_enrichment.ts";
import { fetchResourceMetadata } from "../_shared/v3_youtube.ts";
import { ensureMethod, HttpError, json, withHttp } from "../_shared/http.ts";

export default {
  fetch: withSupabase({ auth: "secret:*" }, async (req, ctx) => {
    const rpc: CanonicalRpc = async (name, values) => {
      const { data, error } = await ctx.supabaseAdmin.rpc(name, values).abortSignal(AbortSignal.timeout(10000));
      if (error) throw new HttpError(error.code === "22023" ? 409 : 503, "canonical_boundary_failed");
      return data;
    };
    if (new URL(req.url).pathname.endsWith("/work")) {
      return await withHttp(req, async () => {
        ensureMethod(req, "POST");
        if (Deno.env.get("FACODI_CANONICAL_WORKER_ENABLED") !== "true") {
          throw new HttpError(503, "canonical_worker_disabled");
        }
        const receipt = await processCanonicalJob({
          claim: async () => await rpc("facodi_canonical_claim") as CanonicalJob | null,
          checkpoint: async (job, key, value) => {
            await rpc("facodi_canonical_checkpoint", {
              p_job_id: job.id, p_token: job.claim_token, p_key: key, p_value: value,
            });
          },
          finish: async (job, status, result) => await rpc("facodi_canonical_finish", {
            p_job_id: job.id, p_token: job.claim_token, p_status: status, p_result: result,
          }),
          metadata: async (request) => await fetchResourceMetadata(request.source_url, {
            provider: request.source_type, title: request.title, language: request.language,
          }),
          analyze: async (_metadata, request) => {
            const accepted = request.provider_config;
            const key = accepted.provider === "gemini" ? Deno.env.get("FACODI_ENRICHMENT_API_KEY") ?? null : null;
            if (accepted.provider === "gemini" && !key) throw new HttpError(503, "accepted_provider_unavailable");
            return await enrichCanonicalText(request, key);
          },
        });
        return json({ receipt });
      });
    }
    return await canonicalTransport(req, rpc);
  }),
};