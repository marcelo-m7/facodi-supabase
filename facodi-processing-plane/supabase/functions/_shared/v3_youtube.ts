import { HttpError } from "./v2_http.ts";

export interface ResourceMetadata {
  provider: string;
  external_id: string | null;
  canonical_url: string;
  title: string | null;
  description: string | null;
  author_name: string | null;
  author_url: string | null;
  thumbnail_url: string | null;
  duration_seconds: number | null;
  published_at: string | null;
  language: string | null;
  metadata_source: string;
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
]);

function decodeJsonString(value: string): string {
  try {
    return JSON.parse('"' + value + '"') as string;
  } catch (_error) {
    return value
      .replace(/\\n/g, "\n")
      .replace(/\\u0026/g, "&")
      .replace(/\\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

function firstMatch(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern);
  return match?.[1]?.trim() || null;
}

export function extractYouTubeVideoId(input: string): string | null {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(value)) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch (_error) {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!YOUTUBE_HOSTS.has(host)) return null;

  let candidate: string | null = null;
  if (host === "youtu.be") {
    candidate = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (url.pathname === "/watch") {
    candidate = url.searchParams.get("v");
  } else {
    const parts = url.pathname.split("/").filter(Boolean);
    if (["shorts", "embed"].includes(parts[0] ?? "")) {
      candidate = parts[1] ?? null;
    }
  }

  return candidate && /^[A-Za-z0-9_-]{11}$/.test(candidate) ? candidate : null;
}

export function canonicalYouTubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchResourceMetadata(
  sourceUrl: string,
  fallback: Partial<ResourceMetadata> = {},
): Promise<ResourceMetadata> {
  const videoId = extractYouTubeVideoId(sourceUrl);
  if (!videoId) {
    return {
      provider: fallback.provider ?? "generic",
      external_id: fallback.external_id ?? null,
      canonical_url: sourceUrl,
      title: fallback.title ?? null,
      description: fallback.description ?? null,
      author_name: fallback.author_name ?? null,
      author_url: fallback.author_url ?? null,
      thumbnail_url: fallback.thumbnail_url ?? null,
      duration_seconds: fallback.duration_seconds ?? null,
      published_at: fallback.published_at ?? null,
      language: fallback.language ?? null,
      metadata_source: "odoo_submission",
    };
  }

  const canonical = canonicalYouTubeUrl(videoId);
  let oembed: Record<string, unknown> = {};
  let html = "";

  try {
    const response = await fetchWithTimeout(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`,
      { headers: { "user-agent": "FACODI processing plane" } },
    );
    if (response.ok) {
      oembed = await response.json() as Record<string, unknown>;
    }
  } catch (_error) {
    // Watch-page metadata remains a fallback.
  }

  try {
    const response = await fetchWithTimeout(canonical, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151 Safari/537.36 FACODI",
      },
    });
    if (response.ok) html = await response.text();
  } catch (_error) {
    // oEmbed metadata is still useful when the watch page is temporarily blocked.
  }

  if (!Object.keys(oembed).length && !html) {
    throw new HttpError(
      424,
      "youtube_metadata_unavailable",
      "YouTube metadata is temporarily unavailable.",
    );
  }

  const shortDescriptionRaw = firstMatch(
    html,
    /"shortDescription":"((?:\\.|[^"\\])*)"/,
  );
  const duration = firstMatch(html, /"lengthSeconds":"(\d+)"/);
  const publishDate =
    firstMatch(html, /"publishDate":"([^"]+)"/) ||
    firstMatch(html, /"uploadDate":"([^"]+)"/);
  const htmlLanguage = firstMatch(html, /<html[^>]+lang=["']([^"']+)["']/i);
  const ogTitle = firstMatch(
    html,
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  );
  const ogImage = firstMatch(
    html,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
  );

  return {
    provider: "youtube",
    external_id: videoId,
    canonical_url: canonical,
    title:
      ogTitle ||
      (typeof oembed.title === "string" ? oembed.title : null) ||
      fallback.title ||
      null,
    description:
      (shortDescriptionRaw ? decodeJsonString(shortDescriptionRaw) : null) ||
      fallback.description ||
      null,
    author_name:
      (typeof oembed.author_name === "string" ? oembed.author_name : null) ||
      fallback.author_name ||
      null,
    author_url:
      (typeof oembed.author_url === "string" ? oembed.author_url : null) ||
      fallback.author_url ||
      null,
    thumbnail_url:
      ogImage ||
      (typeof oembed.thumbnail_url === "string" ? oembed.thumbnail_url : null) ||
      fallback.thumbnail_url ||
      null,
    duration_seconds: duration ? Number(duration) : fallback.duration_seconds ?? null,
    published_at: publishDate || fallback.published_at || null,
    language: fallback.language || htmlLanguage || null,
    metadata_source: "youtube_public",
  };
}
