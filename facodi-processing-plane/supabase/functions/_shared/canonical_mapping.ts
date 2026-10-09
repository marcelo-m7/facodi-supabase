import { HttpError } from "./http.ts";
import type { EnrichedText } from "./canonical_enrichment.ts";

export interface CatalogTarget {
  id: string;
  name: string;
  type: "course";
  code: string | null;
  description: string | null;
  tags: string[];
  topics: string[];
  metadata: { model: "slide.channel"; res_id: number; website_id: number; company_id: number };
}

export interface AcceptedCatalog {
  snapshot_id: string;
  snapshot_hash: string;
  created_at: string;
  schema_version: "2.0.0";
  targets: CatalogTarget[];
  metadata: { company_id: number; website_id: number; ranking: string };
}

export function validateAcceptedCatalog(value: unknown, companyId?: number): AcceptedCatalog {
  const invalid = () => { throw new HttpError(400, "invalid_accepted_catalog"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const catalog = value as AcceptedCatalog;
  const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
  if (Object.keys(catalog).sort().join(",") !== "created_at,metadata,schema_version,snapshot_hash,snapshot_id,targets" ||
      catalog.schema_version !== "2.0.0" || typeof catalog.snapshot_id !== "string" ||
      !/^catalog-[1-9][0-9]*-[a-f0-9]{20}$/.test(catalog.snapshot_id) ||
      typeof catalog.snapshot_hash !== "string" || !/^[a-f0-9]{64}$/.test(catalog.snapshot_hash) ||
      typeof catalog.created_at !== "string" || !Number.isFinite(Date.parse(catalog.created_at)) ||
      !catalog.metadata || !positive(catalog.metadata.company_id) || !positive(catalog.metadata.website_id) ||
      Object.keys(catalog.metadata).sort().join(",") !== "company_id,ranking,website_id" ||
      (companyId !== undefined && catalog.metadata.company_id !== companyId) ||
      catalog.snapshot_id.split("-")[1] !== String(catalog.metadata.website_id) ||
      catalog.metadata.ranking !== "lexical score; not calibrated probability" ||
      !Array.isArray(catalog.targets) || catalog.targets.length > 5000) return invalid();
  const identities = new Set<string>();
  for (const target of catalog.targets) {
    if (!target || typeof target !== "object" ||
        Object.keys(target).sort().join(",") !== "code,description,id,metadata,name,tags,topics,type" ||
        target.type !== "course" || typeof target.name !== "string" ||
        (target.code !== null && typeof target.code !== "string") ||
        (target.description !== null && typeof target.description !== "string") ||
        !Array.isArray(target.tags) || !Array.isArray(target.topics) ||
        [...target.tags, ...target.topics].some((term) => typeof term !== "string") ||
        !target.metadata || target.metadata.model !== "slide.channel" || !positive(target.metadata.res_id) ||
        Object.keys(target.metadata).sort().join(",") !== "company_id,model,res_id,website_id" ||
        target.metadata.website_id !== catalog.metadata.website_id ||
        target.metadata.company_id !== catalog.metadata.company_id ||
        target.id !== `channel_${target.metadata.res_id}` || identities.has(target.id)) return invalid();
    identities.add(target.id);
  }
  return catalog;
}

function nativeCatalogJson(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value).replace(/[\u007f-\uffff]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  }
  if (Array.isArray(value)) return `[${value.map(nativeCatalogJson).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${nativeCatalogJson(key)}: ${nativeCatalogJson(object[key])}`).join(", ")}}`;
  }
  return JSON.stringify(value);
}

export async function verifyAcceptedCatalog(catalog: AcceptedCatalog): Promise<void> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nativeCatalogJson(catalog.targets)));
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (fingerprint !== catalog.snapshot_hash) throw new HttpError(400, "accepted_catalog_hash_conflict");
}

export function mapAcceptedCatalog(document: EnrichedText, catalog: AcceptedCatalog, documentId: string) {
  const concepts = new Map(document.concepts.map((concept) => [concept.name.toLowerCase(), concept.name]));
  const topics = new Set(document.topics.map((topic) => topic.toLowerCase()));
  const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? []);
  const summary = words(document.summary);
  const matched = new Set<string>();
  const candidates = [];
  for (const target of catalog.targets) {
    const names = words(target.name);
    const tags = new Set(target.tags.map((tag) => tag.toLowerCase()));
    const targetTopics = new Set(target.topics.map((topic) => topic.toLowerCase()));
    const matchedConcepts: string[] = [];
    const evidence: string[] = [];
    let score = 0;
    for (const [name, original] of concepts) {
      if (names.has(name) || tags.has(name) || targetTopics.has(name)) {
        matchedConcepts.push(original);
        matched.add(name);
        score += 0.30;
      }
    }
    for (const tag of [...tags].sort()) {
      if (concepts.has(tag) || topics.has(tag) || summary.has(tag)) {
        evidence.push(`tag:${tag}`);
        score += 0.25;
      }
    }
    for (const name of [...names].sort()) {
      if (concepts.has(name)) { evidence.push(`termo:${name}`); score += 0.20; }
      else if (summary.has(name)) { evidence.push(`sum\u00e1rio:${name}`); score += 0.10; }
    }
    score = Math.min(Math.round(score * 100) / 100, 1);
    if (score >= 0.25) {
      candidates.push({ target_id: target.id, target_name: target.name, target_type: target.type,
        relation: "matches_course", score, confidence: score,
        justification: `Correspond\u00eancia encontrada com base em: ${[...evidence, ...matchedConcepts].join(", ")}`,
        evidence, matched_concepts: matchedConcepts });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  return { id: crypto.randomUUID(), enriched_document_id: documentId,
    snapshot_id: catalog.snapshot_id, snapshot_hash: catalog.snapshot_hash,
    candidates: candidates.slice(0, 5),
    unmatched_concepts: document.concepts.filter((concept) => !matched.has(concept.name.toLowerCase())).map((concept) => concept.name),
    ranking_algorithm_version: "deterministic-v2", created_at: new Date().toISOString(), schema_version: "2.0.0" };
}