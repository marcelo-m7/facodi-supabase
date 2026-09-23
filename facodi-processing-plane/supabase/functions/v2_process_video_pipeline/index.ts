import { requireInternalAuth } from "../_shared/v2_auth.ts";
import { ensureMethod, json, readJson, withHttp } from "../_shared/v2_http.ts";
import { processVideoPipeline, type ProcessPipelinePayload } from "../_shared/v2_pipeline.ts";
import { createAdminClient } from "../_shared/v2_supabase.ts";

Deno.serve((req) =>
  withHttp(req, async () => {
    ensureMethod(req, "POST");
    const admin = createAdminClient();
    const auth = await requireInternalAuth(req, admin);
    const payload = await readJson<ProcessPipelinePayload>(req);
    const result = await processVideoPipeline(admin, payload);

    return json({
      auth_mode: auth.mode,
      ...result,
    });
  })
);
