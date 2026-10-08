import { ensureMethod, HttpError, json, withHttp } from "./http.ts";
import { validateCanonicalRequest } from "./canonical_worker.ts";
import { verifyAcceptedCatalog } from "./canonical_mapping.ts";

export type CanonicalRpc = (name: string, values?: Record<string, unknown>) => Promise<unknown>;

export async function boundedBody(req: Request): Promise<Record<string, unknown>> {
  const limit = 65536;
  const declared = req.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    throw new HttpError(413, "payload_too_large");
  }
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_json");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, "payload_too_large"); }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (_error) { throw new HttpError(400, "invalid_json"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_json");
  return body as Record<string, unknown>;
}

export function canonicalScope(body: Record<string, unknown>): Record<string, unknown> {
  if (typeof body.task_ref !== "string" ||
      !/^task:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.task_ref) ||
      !Number.isSafeInteger(body.company_id) || Number(body.company_id) <= 0 || body.cohort !== "p2") {
    throw new HttpError(400, "invalid_identity_scope");
  }
  return { p_task_ref: body.task_ref, p_company_id: body.company_id, p_cohort: body.cohort };
}

export async function canonicalTransport(req: Request, rpc: CanonicalRpc): Promise<Response> {
  return await withHttp(req, async () => {
    ensureMethod(req, "POST");
    const body = await boundedBody(req);
    const scope = canonicalScope(body);
    if (body.action === "submit") {
      const request = validateCanonicalRequest(body.request, Number(body.company_id));
      if (request.catalog_snapshot) await verifyAcceptedCatalog(request.catalog_snapshot);
      const receipt = await rpc("facodi_canonical_enqueue", { ...scope, p_request: request });
      return json({ receipt }, 202);
    }
    if (body.action === "receipt" && typeof body.job_id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.job_id)) {
      const receipt = await rpc("facodi_canonical_receipt", { ...scope, p_job_id: body.job_id });
      if (!receipt) throw new HttpError(404, "receipt_not_found");
      return json({ receipt });
    }
    if (body.action === "cancel" && typeof body.job_id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.job_id) &&
        typeof body.command_id === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.command_id) &&
        Number.isSafeInteger(body.expected_revision) && Number(body.expected_revision) >= 0) {
      const response = await rpc("facodi_canonical_cancel", {
        ...scope, p_job_id: body.job_id, p_command_id: body.command_id,
        p_expected_revision: body.expected_revision,
      });
      return json(response);
    }
    throw new HttpError(400, "invalid_action");
  });
}