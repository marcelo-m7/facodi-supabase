import { processCanonicalJob, validateCanonicalRequest, type AnalysisCheckpoint, type CanonicalJob, type WorkerBoundary } from "../supabase/functions/_shared/canonical_worker.ts";
import type { ResourceMetadata } from "../supabase/functions/_shared/v3_youtube.ts";
import { baselineText, chunkText, enrichCanonicalText, validateEnrichedText } from "../supabase/functions/_shared/canonical_enrichment.ts";
import { canonicalTransport } from "../supabase/functions/_shared/canonical_transport.ts";
import endpoint from "../supabase/functions/v4_canonical_analysis/index.ts";
import { mapAcceptedCatalog, validateAcceptedCatalog, verifyAcceptedCatalog, type AcceptedCatalog } from "../supabase/functions/_shared/canonical_mapping.ts";
import { fetchTranscript, YoutubeTranscriptVideoUnavailableError } from "npm:youtube-transcript-plus@2.0.3";
import { acquireCanonicalYoutube } from "../supabase/functions/_shared/canonical_ingestion.ts";
import { HttpError } from "../supabase/functions/_shared/http.ts";

function assert(value: unknown, message = "assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

function transcriptResponse(path: string, captionUrl = "https://www.youtube.com/api/timedtext?v=4GVbqYFmGBw&lang=pt", text = "Durable &amp; safe evidence."): Response {
  if (path === "/watch") return new Response('"INNERTUBE_API_KEY":"fixture"');
  if (path === "/youtubei/v1/player") return Response.json({
    playabilityStatus: { status: "OK" }, videoDetails: { videoId: "4GVbqYFmGBw", title: "Private evidence" },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: "pt", baseUrl: captionUrl }] } },
  });
  return new Response(`<transcript><text start="0" dur="1">${text}</text></transcript>`);
}

Deno.test("pinned transcript parser runs on Deno without hidden rate-limit retries", async () => {
  let calls = 0;
  try {
    await fetchTranscript("4GVbqYFmGBw", {
      retries: 0,
      videoFetch: async ({ url }) => {
        assert(new URL(url).hostname === "www.youtube.com");
        calls += 1;
        return new Response("", { status: 429 });
      },
      playerFetch: async () => { throw new Error("Unexpected player request"); },
      transcriptFetch: async () => { throw new Error("Unexpected transcript request"); },
    });
    throw new Error("Rate limit was accepted");
  } catch (error) {
    assert(error instanceof YoutubeTranscriptVideoUnavailableError);
  }
  assert(calls === 1);
});

function fixture() {
  const calls: string[] = [];
  const job = {
    id: crypto.randomUUID(), task_ref: `task:${crypto.randomUUID()}`, company_id: 1,
    cohort: "p2", attempt: 1, claim_token: crypto.randomUUID(), checkpoint: {},
    lease_until: new Date(Date.now() + 120000).toISOString(),
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

Deno.test("canonical transcript acquisition uses the pinned parser and bounded identity-safe network", async () => {
  const calls: string[] = [];
  const transport = (async (input, init) => {
    const url = new URL(String(input));
    assert(init?.redirect === "error" && init.signal instanceof AbortSignal);
    calls.push(url.pathname);
    return transcriptResponse(url.pathname);
  }) as typeof fetch;
  const result = await acquireCanonicalYoutube({ source_url: "https://www.youtube.com/watch?v=4GVbqYFmGBw",
    title: "Accepted title", language: "pt" }, transport);
  assert(calls.join(",") === "/watch,/youtubei/v1/player,/api/timedtext");
  assert(result.document_data?.text_content === "Durable & safe evidence.");
  assert(result.document_data.extraction_version === "2.0.3" && result.language === "pt");
});

Deno.test("canonical transcript rate limits become safe input failures without hidden requests", async () => {
  let calls = 0;
  try {
    await acquireCanonicalYoutube({ source_url: "https://www.youtube.com/watch?v=4GVbqYFmGBw",
      title: "Accepted title", language: "pt" }, (async () => {
      calls += 1;
      return new Response("", { status: 429 });
    }) as typeof fetch);
    throw new Error("Blocked acquisition was accepted");
  } catch (error) {
    assert(error instanceof HttpError && error.code === "YOUTUBE_IP_BLOCKED");
  }
  assert(calls === 1);
});

Deno.test("canonical transcript caption URLs cannot redirect acquisition to another authority or video", async () => {
  for (const captionUrl of ["https://127.0.0.1/api/timedtext?v=4GVbqYFmGBw",
      "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ",
      "https://www.youtube.com:444/api/timedtext?v=4GVbqYFmGBw",
      "https://secret@www.youtube.com/api/timedtext?v=4GVbqYFmGBw"]) {
    let calls = 0;
    try {
      await acquireCanonicalYoutube({ source_url: "https://www.youtube.com/watch?v=4GVbqYFmGBw",
        title: "Accepted title", language: "pt" }, (async (input) => {
        calls += 1;
        return transcriptResponse(new URL(String(input)).pathname, captionUrl);
      }) as typeof fetch);
      throw new Error("Changed caption authority was accepted");
    } catch (error) {
      assert(error instanceof HttpError && error.code === "CANONICAL_INPUT_CHANGED");
    }
    assert(calls === 2);
  }
});

Deno.test("canonical transcript rejects oversized HTTP or extracted text instead of truncating", async () => {
  for (const oversizedHttp of [true, false]) {
    let calls = 0;
    try {
      await acquireCanonicalYoutube({ source_url: "https://www.youtube.com/watch?v=4GVbqYFmGBw",
        title: "Accepted title", language: "pt" }, (async (input) => {
        calls += 1;
        return oversizedHttp ? new Response("x".repeat(2097153)) :
          transcriptResponse(new URL(String(input)).pathname, undefined, "x".repeat(12001));
      }) as typeof fetch);
      throw new Error("Oversized acquisition was accepted");
    } catch (error) {
      assert(error instanceof HttpError && error.code === "INPUT_BUDGET_EXHAUSTED");
    }
    assert(calls === (oversizedHttp ? 1 : 3));
  }
});

Deno.test("fresh worker persists each checkpoint before an unpublished terminal result", async () => {
  const test = fixture();
  const result = await processCanonicalJob(test.boundary) as Record<string, unknown>;
  assert(test.calls.join(",") === "metadata,checkpoint:metadata,analyze,checkpoint:analysis,needs_review");
  assert((result.document_data as { text_content: string }).text_content === test.job.request_payload.raw_content);
  assert(!("publication" in result));
});

Deno.test("automatic transcript recovery reuses immutable acquisition before paid analysis", async () => {
  const test = fixture();
  test.job.request_payload = { ...test.job.request_payload, source_type: "youtube",
    source_url: "https://www.youtube.com/watch?v=4GVbqYFmGBw", raw_content: "",
    acquisition_config: { provider: "youtube-transcript-plus", version: "2.0.3" } };
  const metadata = { ...test.metadata, document_data: {
    text_content: "Acquired source evidence", language: "pt", source_url: test.job.request_payload.source_url,
    extraction_provider: "youtube-transcript-plus", extraction_version: "2.0.3",
  } };
  test.boundary.metadata = async () => { test.calls.push("acquire"); return metadata; };
  test.boundary.checkpoint = async (_job, key, value) => {
    test.calls.push(`checkpoint:${key}`);
    test.job.checkpoint[key] = value;
  };
  test.boundary.analyze = async (_metadata, request) => {
    assert(request.raw_content === metadata.document_data.text_content);
    assert(test.job.request_payload.raw_content === "");
    test.calls.push("analyze");
    return { ...test.analysis, document_data: { text_content: request.raw_content, language: request.language } };
  };
  await processCanonicalJob(test.boundary);
  assert(test.calls.join(",") === "acquire,checkpoint:metadata,analyze,checkpoint:analysis,needs_review");
  test.calls.length = 0;
  await processCanonicalJob(test.boundary);
  assert(test.calls.join(",") === "needs_review");
  assert(test.job.request_payload.raw_content === "");
});

Deno.test("automatic transcript input failures finish safely before checkpoint or payment", async () => {
  const test = fixture();
  test.job.request_payload = { ...test.job.request_payload, source_type: "youtube",
    source_url: "https://www.youtube.com/watch?v=4GVbqYFmGBw", raw_content: "",
    acquisition_config: { provider: "youtube-transcript-plus", version: "2.0.3" } };
  test.boundary.metadata = async () => { throw new HttpError(422, "YOUTUBE_LANGUAGE_UNAVAILABLE"); };
  const result = await processCanonicalJob(test.boundary) as Record<string, unknown>;
  assert(result.error_code === "YOUTUBE_LANGUAGE_UNAVAILABLE" && test.calls.join(",") === "failed");
});

Deno.test("automatic transcript recovery rejects changed source evidence without payment", async () => {
  const test = fixture();
  test.job.request_payload = { ...test.job.request_payload, source_type: "youtube",
    source_url: "https://www.youtube.com/watch?v=4GVbqYFmGBw", raw_content: "",
    acquisition_config: { provider: "youtube-transcript-plus", version: "2.0.3" } };
  test.job.checkpoint.metadata = { ...test.metadata, document_data: { text_content: "Changed evidence",
    language: "pt", source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    extraction_provider: "youtube-transcript-plus", extraction_version: "2.0.3" } };
  const result = await processCanonicalJob(test.boundary) as Record<string, unknown>;
  assert(result.error_code === "INVALID_SOURCE_CHECKPOINT" && test.calls.join(",") === "failed");
});

function catalogFixture(): AcceptedCatalog {
  return { snapshot_id: "catalog-1-" + "1".repeat(20),
    snapshot_hash: "b492986eb79376c90716679f3723f3d38b8ac49bc8932f226fcc38ed43c752b6",
    created_at: "2026-10-08T00:00:00", schema_version: "2.0.0",
    metadata: { company_id: 1, website_id: 1, ranking: "lexical score; not calibrated probability" },
    targets: ["Statistics", "Algebra", "Evidence"].map((name, index) => ({
      id: `channel_${index + 1}`, name, type: "course", code: null, description: null,
      tags: index === 0 ? ["Probability"] : index === 1 ? ["Algebra"] : [], topics: [],
      metadata: { model: "slide.channel", res_id: index + 1, website_id: 1, company_id: 1 },
    })) };
}

Deno.test("catalog fingerprint preserves Python Unicode, astral and control escaping", async () => {
  const catalog = catalogFixture();
  catalog.targets[0].name = "Stat\u00edstics \ud83d\ude00";
  catalog.targets[0].description = "\u007f\n\t\b";
  catalog.snapshot_hash = "ec197d9ee1306fcddf2351bb9f7dc68c1a0c70e2bb1b8a7a39d86f2c91315e37";
  await verifyAcceptedCatalog(validateAcceptedCatalog(catalog, 1));
});

Deno.test("accepted catalog matching preserves native scores, threshold, ties and unmatched concepts", () => {
  const test = fixture();
  const document = { ...test.analysis.enriched_data,
    summary: "Statistics supports evidence and algebra.", topics: ["Probability"],
    concepts: ["Statistics", "Algebra", "Missing"].map((name) => ({ name, category: "Keyword",
      relevance: 0.5, evidence_snippet: name, chunk_indices: [1] })) };
  const catalog = validateAcceptedCatalog(catalogFixture(), 1);
  const result = mapAcceptedCatalog(document, catalog, "accepted-document");
  assert(result.candidates.map((candidate) => candidate.target_id).join(",") === "channel_1,channel_2");
  assert(result.candidates.every((candidate) => candidate.score === 0.75 && candidate.confidence === 0.75));
  assert(result.unmatched_concepts.join(",") === "Missing");
  assert(result.snapshot_hash === catalog.snapshot_hash && result.ranking_algorithm_version === "deterministic-v2");
  catalog.targets = Array.from({ length: 7 }, (_, index) => ({ ...catalog.targets[1],
    id: `channel_${index + 1}`, metadata: { ...catalog.targets[1].metadata, res_id: index + 1 } }));
  assert(mapAcceptedCatalog(document, catalog, "accepted-document").candidates.map((candidate) =>
    candidate.target_id).join(",") === "channel_1,channel_2,channel_3,channel_4,channel_5");
});

Deno.test("catalog worker checkpoint recovery preserves mapping identity without another paid call", async () => {
  const test = fixture();
  test.job.request_payload.catalog_snapshot = catalogFixture();
  await processCanonicalJob(test.boundary);
  const accepted = JSON.stringify(test.analysis.mapping_data);
  test.job.attempt = 4;
  test.job.checkpoint = { metadata: test.metadata, analysis: test.analysis };
  test.calls.length = 0;
  const result = await processCanonicalJob(test.boundary) as AnalysisCheckpoint;
  assert(JSON.stringify(result.mapping_data) === accepted && test.calls.join(",") === "needs_review");
  assert(result.mapping_data?.enriched_document_id === result.enriched_data.id);
});

Deno.test("transport sends only scoped versioned cancellation and retry commands", async () => {
  for (const action of ["cancel", "retry"]) {
  const test = fixture();
  const body = { action, task_ref: test.job.task_ref, company_id: 1, cohort: "p2",
    job_id: test.job.id, command_id: crypto.randomUUID(), expected_revision: 0 };
  let calls = 0;
  const response = await canonicalTransport(new Request("https://boundary.test", { method: "POST",
    body: JSON.stringify(body) }), async (name, values) => {
      calls++;
      assert(name === `facodi_canonical_${action}` && values?.p_task_ref === body.task_ref);
      assert(values?.p_command_id === body.command_id && values?.p_expected_revision === 0);
      return { receipt: { status: "cancelled" }, command_revision: 1 };
    });
  assert(response.status === 200 && (await response.json()).command_revision === 1 && calls === 1);
  for (const changed of [{ command_id: "forged" }, { expected_revision: -1 },
    { expected_revision: true }, { expected_revision: "0" }, { job_id: "forged" },
    { cohort: "legacy" }, { company_id: 0 }, { action: [action] }]) {
    const rejected = await canonicalTransport(new Request("https://boundary.test", { method: "POST",
      body: JSON.stringify({ ...body, ...changed }) }), async () => { throw new Error("must not mutate"); });
    assert(rejected.status === 400);
  }
  }
});

Deno.test("transport rejects a catalog from another company without accepting a job", async () => {
  const test = fixture();
  test.job.request_payload.catalog_snapshot = catalogFixture();
  const response = await canonicalTransport(new Request("https://boundary.test", { method: "POST",
    body: JSON.stringify({ action: "submit", task_ref: test.job.task_ref, company_id: 2, cohort: "p2",
      request: test.job.request_payload }) }), async () => { throw new Error("No queue side effects"); });
  assert(response.status === 400);
});

Deno.test("mapping checkpoint with a different enriched document fails without another paid call", async () => {
  const test = fixture();
  test.job.request_payload.catalog_snapshot = catalogFixture();
  await processCanonicalJob(test.boundary);
  test.analysis.mapping_data!.enriched_document_id = crypto.randomUUID();
  test.job.attempt = 4;
  test.job.checkpoint = { metadata: test.metadata, analysis: test.analysis };
  test.calls.length = 0;
  const result = await processCanonicalJob(test.boundary) as Record<string, unknown>;
  assert(result.error_code === "INVALID_MAPPING_CHECKPOINT" && test.calls.join(",") === "failed");
});

Deno.test("changed catalog text cannot reuse an accepted native fingerprint", async () => {
  const test = fixture();
  test.job.request_payload.catalog_snapshot = catalogFixture();
  test.job.request_payload.catalog_snapshot.targets[0].name = "Renamed after acceptance";
  const response = await canonicalTransport(new Request("https://boundary.test", { method: "POST",
    body: JSON.stringify({ action: "submit", task_ref: test.job.task_ref, company_id: 1, cohort: "p2",
      request: test.job.request_payload }) }), async () => { throw new Error("No queue side effects"); });
  assert(response.status === 400);
  const result = await processCanonicalJob(test.boundary) as Record<string, unknown>;
  assert(result.error_code === "INVALID_ACCEPTED_REQUEST" && test.calls.join(",") === "failed");
});

Deno.test("cross-company catalog is rejected before acquisition or paid analysis", async () => {
  const test = fixture();
  test.job.request_payload.catalog_snapshot = catalogFixture();
  test.job.request_payload.catalog_snapshot.metadata.company_id = 2;
  const result = await processCanonicalJob(test.boundary) as Record<string, unknown>;
  assert(result.error_code === "INVALID_ACCEPTED_REQUEST" && test.calls.join(",") === "failed");
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

Deno.test("explicit retry budget permits only its bounded additional claims", async () => {
  const test = fixture();
  test.job.attempt = 4;
  test.job.analysis_attempt_limit = 5;
  await processCanonicalJob(test.boundary);
  assert(test.calls.join(",") === "metadata,checkpoint:metadata,analyze,checkpoint:analysis,needs_review");
  test.job.attempt = 6;
  test.calls.length = 0;
  const result = await processCanonicalJob(test.boundary) as Record<string, unknown>;
  assert(result.error_code === "ATTEMPT_BUDGET_EXHAUSTED" && test.calls.join(",") === "failed");
});

Deno.test("invalid retry budget fails before acquisition or paid analysis", async () => {
  for (const limit of [1, 21, 2.5, NaN, true, "4"]) {
    const test = fixture();
    test.job.analysis_attempt_limit = limit as number;
    const result = await processCanonicalJob(test.boundary) as Record<string, unknown>;
    assert(result.error_code === "INVALID_ATTEMPT_BUDGET" && test.calls.join(",") === "failed");
  }
});

Deno.test("insufficient lease budget never starts a paid provider call", async () => {
  const test = fixture();
  test.job.checkpoint = { metadata: test.metadata };
  test.job.lease_until = new Date(Date.now() + 10000).toISOString();
  let rejected = false;
  try { await processCanonicalJob(test.boundary); }
  catch (error) { rejected = String(error).includes("INSUFFICIENT_LEASE_BUDGET"); }
  assert(rejected && test.calls.length === 0);
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
    await sql("truncate public.facodi_canonical_commands, public.facodi_canonical_jobs, pgmq.q_facodi_canonical_analysis, pgmq.a_facodi_canonical_analysis;", {}, "postgres");
    const functions = new Set(["facodi_canonical_enqueue", "facodi_canonical_claim", "facodi_canonical_checkpoint", "facodi_canonical_finish", "facodi_canonical_receipt", "facodi_canonical_cancel", "facodi_canonical_retry"]);
    const originalFetch = globalThis.fetch;
    const environment = { SUPABASE_URL: "http://127.0.0.1:54321", SUPABASE_SECRET_KEY: "sb_secret_disposable_test",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_disposable_test", FACODI_CANONICAL_WORKER_ENABLED: "true" };
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, Deno.env.get(key)]));
    try {
      for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
      globalThis.fetch = (async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.hostname === "www.youtube.com") {
          assert(!request.headers.has("apikey") && init?.redirect === "error");
          return transcriptResponse(url.pathname);
        }
        const name = url.pathname.split("/").at(-1)!;
        assert(url.origin === environment.SUPABASE_URL && functions.has(name));
        assert(request.headers.get("apikey") === environment.SUPABASE_SECRET_KEY);
        const values = await request.json() as Record<string, unknown>;
        const argumentsSql = Object.keys(values).map((key) => `${key} => :'${key}'`).join(",");
        const value = await sql(`select public.${name}(${argumentsSql});`, values);
        return Response.json(value);
      }) as typeof fetch;
      const test = fixture();
      test.job.request_payload.catalog_snapshot = catalogFixture();
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
      assert(completed.result.mapping_data.snapshot_hash === test.job.request_payload.catalog_snapshot.snapshot_hash);
      assert(completed.result.mapping_data.enriched_document_id === completed.result.enriched_data.id);
      assert(!("publication" in completed.result));
      const replay = (await (await call("", submit)).json()).receipt;
      assert(JSON.stringify(replay) === JSON.stringify(completed));
      assert(await sql("select count(*) from public.facodi_canonical_jobs;") === 1);
      assert(await sql("select count(*) from pgmq.q_facodi_canonical_analysis;") === 0);
      assert(await sql("select count(*) from pgmq.a_facodi_canonical_analysis;") === 1);
      const cancel = { action: "cancel", task_ref: test.job.task_ref, company_id: 1, cohort: "p2",
        job_id: first.job_id, command_id: crypto.randomUUID(), expected_revision: 0 };
      const withdrawn = await call("", cancel);
      assert(withdrawn.status === 200);
      const command = await withdrawn.json();
      assert(command.command_id === cancel.command_id && command.command_revision === 1);
      assert(command.receipt.status === "cancelled" && command.receipt.revision > completed.revision);
      assert(JSON.stringify(await (await call("", cancel)).json()) === JSON.stringify(command));
      assert(JSON.stringify(await sql("select prior_receipt from public.facodi_canonical_commands;")) === JSON.stringify(completed));
      assert(await sql("select count(*) from public.facodi_canonical_commands;") === 1);
      const retrySubmit = { ...submit, task_ref: `task:${crypto.randomUUID()}` };
      const retryJob = (await (await call("", retrySubmit)).json()).receipt;
      const previousClaim = await sql("select public.facodi_canonical_claim();");
      const { metadata, ...savedAnalysis } = completed.result;
      for (const [key, value] of Object.entries({ metadata, analysis: savedAnalysis })) {
        await sql("select public.facodi_canonical_checkpoint(:'p_job_id', :'p_token', :'p_key', :'p_value');",
          { p_job_id: retryJob.job_id, p_token: previousClaim.claim_token, p_key: key, p_value: value });
      }
      const failed = await sql("select public.facodi_canonical_finish(:'p_job_id', :'p_token', 'failed', :'p_result');",
        { p_job_id: retryJob.job_id, p_token: previousClaim.claim_token,
          p_result: { error_code: "DISPOSABLE_CRASH_AFTER_CHECKPOINT" } });
      const retry = { action: "retry", task_ref: retrySubmit.task_ref, company_id: 1, cohort: "p2",
        job_id: retryJob.job_id, command_id: crypto.randomUUID(), expected_revision: 0 };
      const retriedResponse = await call("", retry);
      assert(retriedResponse.status === 200);
      const retried = await retriedResponse.json();
      assert(retried.command_id === retry.command_id && retried.command_revision === 1);
      assert(retried.receipt.status === "queued" && retried.receipt.attempt === 1);
      assert(JSON.stringify(await sql("select prior_receipt from public.facodi_canonical_commands where id=:'p_command_id';",
        { p_command_id: retry.command_id })) === JSON.stringify(failed));
      const recovered = (await (await call("/work", {})).json()).receipt;
      assert(recovered.job_id === retryJob.job_id && recovered.attempt === 2 && recovered.status === "needs_review");
      assert(JSON.stringify(recovered.result) === JSON.stringify(completed.result));
      assert(JSON.stringify(await (await call("", retry)).json()) === JSON.stringify(retried));
      assert(await sql("select count(*) from public.facodi_canonical_commands;") === 2);
      const automaticSubmit = { ...submit, task_ref: `task:${crypto.randomUUID()}`,
        request: { ...submit.request, source_type: "youtube", raw_content: "",
          source_url: "https://www.youtube.com/watch?v=4GVbqYFmGBw",
          acquisition_config: { provider: "youtube-transcript-plus", version: "2.0.3" } } };
      const automaticAccepted = await call("", automaticSubmit);
      assert(automaticAccepted.status === 202);
      const automaticJob = (await automaticAccepted.json()).receipt;
      const automaticWork = await call("/work", {});
      assert(automaticWork.status === 200);
      const automaticReceipt = (await automaticWork.json()).receipt;
      assert(automaticReceipt.job_id === automaticJob.job_id && automaticReceipt.status === "needs_review");
      assert(automaticReceipt.result.document_data.text_content === "Durable & safe evidence.");
      assert(automaticReceipt.result.metadata.document_data.extraction_version === "2.0.3");
      assert(submit.request.catalog_snapshot);
      assert(automaticReceipt.result.mapping_data.snapshot_hash === submit.request.catalog_snapshot.snapshot_hash);
      assert(!("publication" in automaticReceipt.result));
      assert(JSON.stringify((await (await call("", automaticSubmit)).json()).receipt) === JSON.stringify(automaticReceipt));
      assert(await sql("select request_payload->'raw_content' from public.facodi_canonical_jobs where id=:'p_job_id';",
        { p_job_id: automaticJob.job_id }) === "");
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
      }
    }
  },
});