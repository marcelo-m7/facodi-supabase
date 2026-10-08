import { processCanonicalJob, validateCanonicalRequest, type AnalysisCheckpoint, type CanonicalJob, type WorkerBoundary } from "../supabase/functions/_shared/canonical_worker.ts";
import type { ResourceMetadata } from "../supabase/functions/_shared/v3_youtube.ts";
import { baselineText, chunkText, enrichCanonicalText, validateEnrichedText } from "../supabase/functions/_shared/canonical_enrichment.ts";
import { canonicalTransport } from "../supabase/functions/_shared/canonical_transport.ts";
import endpoint from "../supabase/functions/v4_canonical_analysis/index.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function fixture() {
  const calls: string[] = [];
  const job = {
    id: crypto.randomUUID(), task_ref: `task:${crypto.randomUUID()}`, company_id: 1,
    cohort: "p2", attempt: 1, claim_token: crypto.randomUUID(), checkpoint: {},
    request_payload: {
      source_type: "manual", source_url: "", title: "Private evidence",
      raw_content: "Human supplied text", language: "pt", provider_config: { provider: "baseline", version: "regex-frequency-v2-evidence" },
    },
  } as CanonicalJob;
  const metadata: ResourceMetadata = {
    title: "Evidence", provider: "manual", external_id: null, canonical_url: "",
    description: null, author_name: null, author_url: null, thumbnail_url: null,
    duration_seconds: null, published_at: null, language: "pt", metadata_source: "accepted_intake",
  };
  const analysis: AnalysisCheckpoint = {
    enriched_data: { summary: "Evidence", topics: [], keywords: [], concepts: [],
      model_name: "regex-frequency-v2-evidence", provider_name: "baseline-deterministic", warnings: [] },
    chunks: [], document_data: { text_content: "Human supplied text", language: "pt" },
  };
  const boundary: WorkerBoundary = {
    claim: async () => job,
    metadata: async () => { calls.push("metadata"); return metadata; },
    analyze: async () => { calls.push("analyze"); return analysis; },
    checkpoint: async (_job, key) => { calls.push(`checkpoint:${key}`); },
    finish: async (_job, status, result) => { calls.push(status); return result; },
  };
  return { job, boundary, calls, metadata, analysis };
}

Deno.test("fresh worker persists each checkpoint before an unpublished terminal result", async () => {
  const test = fixture();
  const result = await processCanonicalJob(test.boundary) as Record<string, unknown>;
  assert(test.calls.join(",") === "metadata,checkpoint:metadata,analyze,checkpoint:analysis,needs_review");
  assert((result.document_data as { text_content: string }).text_content === test.job.request_payload.raw_content);
  assert(!("publication" in result));
});

Deno.test("recovery reuses committed checkpoints without another provider call", async () => {
  const test = fixture();
  test.job.attempt = 4;
  test.job.checkpoint = { metadata: test.metadata, analysis: test.analysis };
  await processCanonicalJob(test.boundary);
  assert(test.calls.join(",") === "needs_review");
});

Deno.test("stale checkpoint claim cannot finish or continue analysis", async () => {
  const test = fixture();
  test.boundary.checkpoint = async () => { throw new Error("stale_claim"); };
  let rejected = false;
  try { await processCanonicalJob(test.boundary); } catch (_error) { rejected = true; }
  assert(rejected);
  assert(test.calls.join(",") === "metadata");
});

Deno.test("provider failure leaves the message recoverable and retains metadata", async () => {
  const test = fixture();
  test.boundary.analyze = async () => { throw new Error("provider unavailable"); };
  let rejected = false;
  try { await processCanonicalJob(test.boundary); } catch (_error) { rejected = true; }
  assert(rejected);
  assert(test.calls.join(",") === "metadata,checkpoint:metadata");
});

Deno.test("attempt budget terminates without another paid provider call", async () => {
  const test = fixture();
  test.job.attempt = 4;
  const result = await processCanonicalJob(test.boundary) as Record<string, unknown>;
  assert(result.error_code === "ATTEMPT_BUDGET_EXHAUSTED");
  assert(test.calls.join(",") === "failed");
});

Deno.test("oversized provider output terminates instead of spending the budget again", async () => {
  const test = fixture();
  test.analysis.enriched_data.summary = "x".repeat(65536);
  const result = await processCanonicalJob(test.boundary) as Record<string, unknown>;
  assert(result.error_code === "OUTPUT_BUDGET_EXHAUSTED");
  assert(test.calls.join(",") === "metadata,checkpoint:metadata,analyze,failed");
});

Deno.test("empty source, unsupported documents and oversized payloads fail closed", () => {
  const test = fixture();
  for (const request of [
    { ...test.job.request_payload, raw_content: "" },
    { ...test.job.request_payload, source_type: "document" },
    { ...test.job.request_payload, raw_content: "x".repeat(65536) },
    { ...test.job.request_payload, credential: "forbidden" },
  ]) {
    let rejected = false;
    try { validateCanonicalRequest(request); } catch (_error) { rejected = true; }
    assert(rejected);
  }
});

Deno.test("idle queue has no processing side effects", async () => {
  const test = fixture();
  test.boundary.claim = async () => null;
  await processCanonicalJob(test.boundary);
  assert(test.calls.length === 0);
});

Deno.test("canonical lexical baseline carries real chunk evidence and provider provenance", () => {
  const text = "Durable queues protect technical history. Durable queues preserve evidence.";
  const chunks = chunkText(text);
  const enriched = baselineText(text, chunks);
  assert(enriched.provider_name === "baseline-deterministic");
  assert(enriched.model_name === "regex-frequency-v2-evidence");
  assert(enriched.summary === text);
  assert(enriched.concepts[0].name === "Durable" && enriched.concepts[0].relevance === 0.2);
  assert(enriched.concepts[0].chunk_indices.join(",") === "1");
  assert(chunks[0].text.includes(enriched.concepts[0].evidence_snippet));
  assert(!enriched.keywords.includes("Metadata_fallback"));
});

Deno.test("chunk normalization preserves paragraph boundaries and the 600-word aggregation contract", () => {
  const chunks = chunkText("\x00  " + "word ".repeat(400) + "\n\n\n" + "next ".repeat(300));
  assert(chunks.length === 2);
  assert(chunks[0].token_count_estimate === 400 && chunks[1].token_count_estimate === 300);
  assert(chunks[0].index === 1 && chunks[1].title === "Bloco 2");
});

Deno.test("Gemini uses the accepted model, budget and evidence schema rather than current environment", async () => {
  const test = fixture();
  test.job.request_payload.provider_config = {
    provider: "gemini", version: "gemini-chunk-evidence-v1", model: "gemini-accepted-model", max_output_tokens: 512,
  };
  let calls = 0;
  const transport = (async (url, init) => {
    calls++;
    assert(String(url).includes("gemini-accepted-model:generateContent"));
    assert(init?.redirect === "error");
    const body = JSON.parse(String(init?.body));
    assert(body.generationConfig.maxOutputTokens === 512);
    assert(body.generationConfig.responseJsonSchema.additionalProperties === false);
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({
      summary: "Human supplied text", topics: ["Evidence"], keywords: ["Human"], concepts: [{
        name: "Human", category: "Keyword", relevance: 0.5, evidence_snippet: "Human supplied text", chunk_indices: [1],
      }],
    }) }] } }] });
  }) as typeof fetch;
  const result = await enrichCanonicalText(test.job.request_payload, "disposable-fixture", transport);
  assert(calls === 1 && result.enriched_data.model_name === "gemini-accepted-model");
  assert(result.enriched_data.provider_name === "gemini-structured");
});

Deno.test("absent accepted Gemini credential never degrades to baseline or sends a request", async () => {
  const test = fixture();
  test.job.request_payload.provider_config = {
    provider: "gemini", version: "gemini-chunk-evidence-v1", model: "gemini-accepted-model", max_output_tokens: 512,
  };
  let rejected = false;
  try { await enrichCanonicalText(test.job.request_payload, null, (() => { throw new Error("must not fetch"); }) as typeof fetch); }
  catch (error) { rejected = String(error).includes("PROVIDER_NOT_CONFIGURED"); }
  assert(rejected);
});

Deno.test("invented snippets, chunk references and publication instructions fail output validation", () => {
  const chunks = chunkText("Actual evidence only");
  for (const output of [
    { summary: "Evidence", topics: [], keywords: [], concepts: [{ name: "Evidence", category: "Keyword", relevance: 0.2, evidence_snippet: "Invented", chunk_indices: [1] }] },
    { summary: "Evidence", topics: [], keywords: [], concepts: [{ name: "Evidence", category: "Keyword", relevance: 0.2, evidence_snippet: "Actual evidence", chunk_indices: [99] }] },
    { summary: "Evidence", topics: [], keywords: [], concepts: [], publish: true },
  ]) {
    let rejected = false;
    try { validateEnrichedText(output, chunks); } catch (_error) { rejected = true; }
    assert(rejected);
  }
});

Deno.test("transport submits a bounded immutable request with exact native identity scope", async () => {
  const test = fixture();
  const response = await canonicalTransport(new Request("https://example.invalid/v4", {
    method: "POST", body: JSON.stringify({ action: "submit", task_ref: test.job.task_ref,
      company_id: 1, cohort: "p2", request: test.job.request_payload }),
  }), async (name, values) => {
    assert(name === "facodi_canonical_enqueue");
    assert(values?.p_task_ref === test.job.task_ref);
    assert(values?.p_company_id === 1 && values?.p_cohort === "p2");
    return { job_id: test.job.id };
  });
  assert(response.status === 202);
});

Deno.test("oversized HTTP body is rejected before any queue operation", async () => {
  let calls = 0;
  const response = await canonicalTransport(new Request("https://example.invalid/v4", {
    method: "POST", body: "x".repeat(65537),
  }), async () => { calls++; return null; });
  assert(response.status === 413 && calls === 0);
});

Deno.test("out-of-scope receipt is a sanitized 404", async () => {
  const test = fixture();
  const response = await canonicalTransport(new Request("https://example.invalid/v4", {
    method: "POST", body: JSON.stringify({ action: "receipt", task_ref: test.job.task_ref,
      company_id: 2, cohort: "p2", job_id: test.job.id }),
  }), async (name, values) => {
    assert(name === "facodi_canonical_receipt" && values?.p_company_id === 2);
    return null;
  });
  assert(response.status === 404);
  assert(!(await response.text()).includes(test.job.id));
});

Deno.test("real secret auth wrapper denies missing and publishable credentials before processing", async () => {
  const environment = { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SECRET_KEY: "sb_secret_disposable_test",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_disposable_test", FACODI_CANONICAL_WORKER_ENABLED: "false" };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, Deno.env.get(key)]));
  try {
    for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
    for (const headers of [new Headers(), new Headers({ apikey: environment.SUPABASE_PUBLISHABLE_KEY })]) {
      const response = await endpoint.fetch(new Request("http://127.0.0.1/v4/work", { method: "POST", headers }));
      assert(response.status === 401 || response.status === 403, `unexpected auth status ${response.status}`);
    }
    const response = await endpoint.fetch(new Request("http://127.0.0.1/v4/work", {
      method: "POST", headers: { apikey: environment.SUPABASE_SECRET_KEY },
    }));
    assert(response.status === 503);
    assert((await response.text()).includes("canonical_worker_disabled"));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
    }
  }
});

Deno.test({
  name: "authenticated endpoint executes the native queue and replays one unpublished receipt",
  ignore: !Deno.env.get("FACODI_CANONICAL_TEST_CONTAINER"),
  fn: async () => {
    const container = Deno.env.get("FACODI_CANONICAL_TEST_CONTAINER")!;
    assert(/^(supabase_db_|facodi_canonical_test_)[a-zA-Z0-9_-]+$/.test(container));
    const sql = async (statement: string, values: Record<string, unknown> = {}, role = "service_role") => {
      const args = ["exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "facodi_canonical_ci"];
      for (const [key, value] of Object.entries(values)) {
        assert(/^p_[a-z_]+$/.test(key));
        args.push("-v", `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
      }
      const dockerEnv: Record<string, string> = {};
      for (const key of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "XDG_RUNTIME_DIR"]) {
        const value = Deno.env.get(key);
        if (value !== undefined) dockerEnv[key] = value;
      }
      const child = new Deno.Command("docker", { args, clearEnv: true, env: dockerEnv,
        stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(`set role ${role}; ${statement}`));
      await writer.close();
      const output = await child.output();
      assert(output.success, new TextDecoder().decode(output.stderr));
      const text = new TextDecoder().decode(output.stdout).trim();
      return text ? JSON.parse(text) : null;
    };
    await sql("truncate public.facodi_canonical_jobs, pgmq.q_facodi_canonical_analysis, pgmq.a_facodi_canonical_analysis;", {}, "postgres");
    const functions = new Set(["facodi_canonical_enqueue", "facodi_canonical_claim", "facodi_canonical_checkpoint", "facodi_canonical_finish", "facodi_canonical_receipt"]);
    const originalFetch = globalThis.fetch;
    const environment = { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SECRET_KEY: "sb_secret_disposable_test",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_disposable_test", FACODI_CANONICAL_WORKER_ENABLED: "true" };
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, Deno.env.get(key)]));
    try {
      for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
      globalThis.fetch = (async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const name = url.pathname.split("/").at(-1)!;
        assert(url.origin === environment.SUPABASE_URL && functions.has(name));
        assert(request.headers.get("apikey") === environment.SUPABASE_SECRET_KEY);
        const values = await request.json() as Record<string, unknown>;
        const argumentsSql = Object.keys(values).map((key) => `${key} => :'${key}'`).join(",");
        const value = await sql(`select public.${name}(${argumentsSql});`, values);
        return Response.json(value);
      }) as typeof fetch;
      const test = fixture();
      const call = (path: string, body: unknown) => endpoint.fetch(new Request(`${environment.SUPABASE_URL}/v4${path}`, {
        method: "POST", headers: { apikey: environment.SUPABASE_SECRET_KEY }, body: JSON.stringify(body),
      }));
      const submit = { action: "submit", task_ref: test.job.task_ref, company_id: 1, cohort: "p2", request: test.job.request_payload };
      const accepted = await call("", submit);
      assert(accepted.status === 202);
      const first = (await accepted.json()).receipt;
      const work = await call("/work", {});
      assert(work.status === 200);
      const completed = (await work.json()).receipt;
      assert(completed.job_id === first.job_id && completed.status === "needs_review" && completed.attempt === 1);
      assert(completed.result.document_data.text_content === test.job.request_payload.raw_content);
      assert(completed.result.enriched_data.provider_name === "baseline-deterministic");
      const replay = (await (await call("", submit)).json()).receipt;
      assert(JSON.stringify(replay) === JSON.stringify(completed));
      assert(await sql("select count(*) from public.facodi_canonical_jobs;") === 1);
      assert(await sql("select count(*) from pgmq.q_facodi_canonical_analysis;") === 0);
      assert(await sql("select count(*) from pgmq.a_facodi_canonical_analysis;") === 1);
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
      }
    }
  },
});