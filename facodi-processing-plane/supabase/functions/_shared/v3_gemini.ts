import { HttpError } from "./v2_http.ts";
import type { ResourceMetadata } from "./v3_youtube.ts";

export interface LearningAnalysis {
  summary: string;
  detected_language: string | null;
  suggested_tags: string[];
  topics: string[];
  learning_objectives: string[];
  difficulty: string | null;
  confidence: number;
  analysis_mode: "gemini" | "metadata_fallback";
}

function normalizeList(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const clean = item.trim();
    if (!clean || result.includes(clean)) continue;
    result.push(clean);
    if (result.length >= limit) break;
  }
  return result;
}

function fallbackAnalysis(
  metadata: ResourceMetadata,
  transcript: string,
): LearningAnalysis {
  const text = [metadata.title, metadata.description, transcript]
    .filter((value): value is string => Boolean(value?.trim()))
    .join("\n\n");
  return {
    summary: text.slice(0, 1200) || metadata.title || "Learning resource",
    detected_language: metadata.language,
    suggested_tags: [],
    topics: [],
    learning_objectives: [],
    difficulty: null,
    confidence: 0.35,
    analysis_mode: "metadata_fallback",
  };
}

export async function analyzeLearningResource(
  metadata: ResourceMetadata,
  transcript: string,
  apiKey: string | null,
): Promise<{ analysis: LearningAnalysis; model_name: string; prompt_version: string }> {
  const fallback = fallbackAnalysis(metadata, transcript);
  if (!apiKey) {
    return {
      analysis: fallback,
      model_name: "metadata-fallback-v1",
      prompt_version: "facodi-learning-resource-v1",
    };
  }

  const model =
    Deno.env.get("FACODI_GEMINI_MODEL")?.trim() ||
    Deno.env.get("GEMINI_MODEL")?.trim() ||
    "gemini-3.8-flash";

  const prompt = {
    task:
      "Analyze this public learning resource for FACODI. Return conservative educational metadata only. Do not claim academic equivalence, ECTS, accreditation, or publication approval.",
    output_schema: {
      summary: "string, max 1200 chars",
      detected_language: "BCP-47-ish short language code or null",
      suggested_tags: "array of concise strings",
      topics: "array of concise strings",
      learning_objectives: "array of concise strings",
      difficulty: "beginner|intermediate|advanced|null",
      confidence: "number from 0 to 1",
    },
    resource: {
      provider: metadata.provider,
      source_url: metadata.canonical_url,
      title: metadata.title,
      description: metadata.description,
      author_name: metadata.author_name,
      published_at: metadata.published_at,
      language_hint: metadata.language,
      transcript: transcript || null,
    },
  };

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: JSON.stringify(prompt) }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
        },
      }),
    },
  );

  if (!response.ok) {
    throw new HttpError(
      424,
      "gemini_failed",
      "Gemini analysis failed.",
      { status: response.status },
    );
  }

  const payload = await response.json() as Record<string, unknown>;
  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  const candidate = (candidates[0] ?? {}) as Record<string, unknown>;
  const content = (candidate.content ?? {}) as Record<string, unknown>;
  const parts = Array.isArray(content.parts) ? content.parts : [];
  const text = typeof (parts[0] as Record<string, unknown> | undefined)?.text === "string"
    ? String((parts[0] as Record<string, unknown>).text)
    : "";

  if (!text) {
    throw new HttpError(424, "gemini_empty_response", "Gemini returned no analysis.");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch (_error) {
    throw new HttpError(424, "gemini_invalid_json", "Gemini returned invalid JSON.");
  }

  const confidenceRaw = Number(parsed.confidence ?? 0.5);
  const analysis: LearningAnalysis = {
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim().slice(0, 1200)
        : fallback.summary,
    detected_language:
      typeof parsed.detected_language === "string" && parsed.detected_language.trim()
        ? parsed.detected_language.trim().slice(0, 32)
        : metadata.language,
    suggested_tags: normalizeList(parsed.suggested_tags),
    topics: normalizeList(parsed.topics),
    learning_objectives: normalizeList(parsed.learning_objectives, 10),
    difficulty:
      typeof parsed.difficulty === "string" &&
      ["beginner", "intermediate", "advanced"].includes(parsed.difficulty)
        ? parsed.difficulty
        : null,
    confidence: Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(confidenceRaw, 1))
      : 0.5,
    analysis_mode: "gemini",
  };

  return {
    analysis,
    model_name: model,
    prompt_version: "facodi-learning-resource-v1",
  };
}
