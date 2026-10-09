import { createAdminClient } from "npm:@supabase/server@1.9.1/core";
import { canonicalBoundary } from "../../supabase/functions/_shared/canonical_boundary.ts";
import { processCanonicalJob, type WorkerBoundary } from "../../supabase/functions/_shared/canonical_worker.ts";
import type { CanonicalRpc } from "../../supabase/functions/_shared/canonical_transport.ts";
import { HttpError } from "../../supabase/functions/_shared/http.ts";

const TARGET = "https://bhfywztfyidvrlarebmg.supabase.co";

export function validateWorkerConfiguration(environment: Record<string, string | undefined>): boolean {
  const enabled = environment.FACODI_ISOLATED_WORKER_ENABLED;
  if (enabled === undefined || enabled === "false") return false;
  if (enabled !== "true" || environment.SUPABASE_URL !== TARGET ||
      !/^sb_secret_[A-Za-z0-9_-]+$/.test(environment.SUPABASE_SECRET_KEY ?? "")) {
    throw new HttpError(503, "isolated_worker_configuration_invalid");
  }
  return true;
}

function runtimeBoundary(): WorkerBoundary {
  const admin = createAdminClient({ supabaseOptions: { global: { fetch: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== TARGET || !["/rest/v1/rpc/facodi_canonical_claim",
        "/rest/v1/rpc/facodi_canonical_checkpoint", "/rest/v1/rpc/facodi_canonical_finish"].includes(url.pathname)) {
      throw new HttpError(503, "canonical_boundary_failed");
    }
    return await fetch(input, { ...init, redirect: "error" });
  } } } });
  const rpc: CanonicalRpc = async (name, values) => {
    const { data, error } = await admin.rpc(name, values).abortSignal(AbortSignal.timeout(10000));
    if (error) throw new HttpError(503, "canonical_boundary_failed");
    return data;
  };
  return canonicalBoundary(rpc, Deno.env.get("FACODI_ENRICHMENT_API_KEY") ?? null);
}

export async function runCanonicalWorkerOnce(environment: Record<string, string | undefined>,
  boundary: () => WorkerBoundary = runtimeBoundary): Promise<"disabled" | "idle" | "processed"> {
  if (!validateWorkerConfiguration(environment)) return "disabled";
  const receipt = await processCanonicalJob(boundary());
  return receipt && typeof receipt === "object" && "idle" in receipt ? "idle" : "processed";
}

async function main(): Promise<void> {
  if (Deno.args.some((argument) => argument !== "--once")) throw new Error("invalid_worker_arguments");
  const environment = {
    FACODI_ISOLATED_WORKER_ENABLED: Deno.env.get("FACODI_ISOLATED_WORKER_ENABLED"),
    SUPABASE_URL: Deno.env.get("SUPABASE_URL"),
    SUPABASE_SECRET_KEY: Deno.env.get("SUPABASE_SECRET_KEY"),
  };
  validateWorkerConfiguration(environment);
  const once = Deno.args.includes("--once");
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  Deno.addSignalListener("SIGTERM", stop);
  Deno.addSignalListener("SIGINT", stop);
  try {
    while (!shutdown.signal.aborted) {
      if (!once) await Deno.writeTextFile("/tmp/facodi-worker-heartbeat", String(Date.now()));
      let status: string;
      try {
        status = await runCanonicalWorkerOnce(environment);
      } catch (_error) {
        status = "recoverable_failure";
        if (once) throw new Error("isolated_worker_execution_failed");
      }
      if (once || status !== "idle") console.log(JSON.stringify({ status }));
      if (once || shutdown.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); shutdown.signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, status === "processed" ? 0 : 15000);
        shutdown.signal.addEventListener("abort", done, { once: true });
      });
    }
  } finally {
    Deno.removeSignalListener("SIGTERM", stop);
    Deno.removeSignalListener("SIGINT", stop);
  }
}

if (import.meta.main) {
  try { await main(); }
  catch (_error) { console.error("isolated_worker_failed"); Deno.exitCode = 1; }
}