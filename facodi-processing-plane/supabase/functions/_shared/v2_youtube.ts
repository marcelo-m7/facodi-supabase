import { HttpError } from "./v2_http.ts";
import { normalizeForSearch, normalizeWhitespace, uniqueStrings } from "./v2_text.ts";

export interface YouTubeMetadata {
  youtube_video_id: string;
  canonical_url: string;
  title: string | null;
  description: string | null;
  channel_id: string | null;
  channel_title: string | null;
  duration_seconds: number | null;
  published_at: string | null;
  thumbnails: Record<string, string>;
  tags: string[];
  language: string | null;
  metadata: Record<string, unknown>;
}

export interface YouTubeChannel {
  channel_id: string;
  title: string;
  handle: string | null;
  canonical_url: string;
  thumbnail_url: string | null;
  source: "youtube_public";
}

export interface YouTubeChannelVideo {
  youtube_video_id: string;
  title: string | null;
  description: string | null;
  channel_id: string | null;
  channel_title: string | null;
  canonical_url: string;
  thumbnail_url: string | null;
  published_at: string | null;
  source: "youtube_public";
}

interface PublicFetchOptions {
  fetcher?: typeof fetch;
}

interface ChannelInput {
  url: string;
  handle: string | null;
  channelId: string | null;
}

const YOUTUBE_ORIGIN = "https://www.youtube.com";

const VIDEO_HINT_TAGS: Record<string, string[]> = {
  "cv_FW6aI-5A": [
    "calculo 1",
    "analise matematica i",
    "limites",
    "derivadas",
    "integrais",
    "equacoes",
    "logaritmo",
    "trigonometria",
  ],
};

export function extractYouTubeVideoId(input: string): string | null {
  const value = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) {
    return value;
  }
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export function canonicalYouTubeUrl(videoId: string): string {
  return `${YOUTUBE_ORIGIN}/watch?v=${videoId}`;
}

export function parseIsoDuration(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

export function normalizeYouTubeChannelInput(input: string): ChannelInput {
  const value = input.trim();
  if (!value) {
    throw new HttpError(400, "missing_channel_input", "Informe um handle ou URL de canal do YouTube.");
  }

  const channelMatch = value.match(/(?:youtube\.com\/)?channel\/(UC[a-zA-Z0-9_-]+)/);
  if (channelMatch) {
    return {
      url: `${YOUTUBE_ORIGIN}/channel/${channelMatch[1]}`,
      handle: null,
      channelId: channelMatch[1],
    };
  }

  const handleMatch = value.match(/@([a-zA-Z0-9_.-]+)/);
  if (handleMatch) {
    return {
      url: `${YOUTUBE_ORIGIN}/@${handleMatch[1]}`,
      handle: `@${handleMatch[1]}`,
      channelId: null,
    };
  }

  if (/^[a-zA-Z0-9_.-]+$/.test(value)) {
    return {
      url: `${YOUTUBE_ORIGIN}/@${value.replace(/^@/, "")}`,
      handle: `@${value.replace(/^@/, "")}`,
      channelId: null,
    };
  }

  throw new HttpError(400, "invalid_youtube_channel", "Canal do YouTube inválido.");
}

async function fetchText(url: string, options: PublicFetchOptions = {}): Promise<string> {
  const response = await (options.fetcher ?? fetch)(url, {
    headers: {
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": "Mozilla/5.0 FACODI public catalog curator",
    },
  });
  if (!response.ok) {
    throw new HttpError(
      response.status === 403 || response.status === 429 ? 424 : 502,
      "youtube_public_blocked",
      "O YouTube bloqueou ou recusou a leitura pública desta página. Tente novamente mais tarde ou informe título/descrição manualmente.",
      { url, status: response.status },
    );
  }
  return await response.text();
}

function decodeHtml(value: string | null | undefined): string {
  return normalizeWhitespace(
    String(value ?? "")
      .replace(/\\u0026/g, "&")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">"),
  );
}

function extractMeta(html: string, key: string): string | null {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${escaped}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]);
  }
  return null;
}

function extractCanonical(html: string): string | null {
  const match = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ??
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  return match ? decodeHtml(match[1]) : null;
}

function extractChannelId(html: string): string | null {
  const canonical = extractCanonical(html);
  const canonicalMatch = canonical?.match(/\/channel\/(UC[a-zA-Z0-9_-]+)/);
  if (canonicalMatch) return canonicalMatch[1];
  const patterns = [
    /"channelId"\s*:\s*"(UC[a-zA-Z0-9_-]+)"/,
    /"externalId"\s*:\s*"(UC[a-zA-Z0-9_-]+)"/,
    /"browseId"\s*:\s*"(UC[a-zA-Z0-9_-]+)"/,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function extractJsonString(segment: string, key: string): string | null {
  const pattern = new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`);
  const match = segment.match(pattern);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch (_error) {
    return decodeHtml(match[1]);
  }
}

function inferTags(videoId: string, ...values: Array<string | null | undefined>): string[] {
  const text = normalizeForSearch(values.filter(Boolean).join(" "));
  const tags = [
    ...(VIDEO_HINT_TAGS[videoId] ?? []),
    "calculo",
    "derivada",
    "derivadas",
    "integral",
    "integrais",
    "limite",
    "limites",
    "equacao",
    "equacoes",
    "logaritmo",
    "trigonometria",
    "matematica",
  ].filter((tag) => text.includes(normalizeForSearch(tag)) || (VIDEO_HINT_TAGS[videoId] ?? []).includes(tag));
  return uniqueStrings(tags);
}

export async function resolveYouTubeChannel(
  input: string,
  options: PublicFetchOptions = {},
): Promise<YouTubeChannel> {
  const normalized = normalizeYouTubeChannelInput(input);
  const html = await fetchText(normalized.url, options);
  const channelId = normalized.channelId ?? extractChannelId(html);
  if (!channelId) {
    throw new HttpError(404, "youtube_channel_not_found", "Não foi possível resolver o ID público do canal.");
  }
  const title = extractMeta(html, "og:title") ?? extractJsonString(html, "title") ?? normalized.handle ?? channelId;
  const thumbnail = extractMeta(html, "og:image");
  return {
    channel_id: channelId,
    title,
    handle: normalized.handle,
    canonical_url: `${YOUTUBE_ORIGIN}/channel/${channelId}`,
    thumbnail_url: thumbnail,
    source: "youtube_public",
  };
}

export const fetchYouTubeChannel = resolveYouTubeChannel;

function parseVideosHtml(html: string, channel: YouTubeChannel, maxVideos: number): YouTubeChannelVideo[] {
  const seen = new Set<string>();
  const videos: YouTubeChannelVideo[] = [];
  const regex = /"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) && videos.length < maxVideos) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const segment = html.slice(Math.max(0, match.index - 1600), Math.min(html.length, match.index + 3200));
    const title = extractJsonString(segment, "text") ?? extractJsonString(segment, "simpleText");
    const thumbnail = extractJsonString(segment, "url");
    videos.push({
      youtube_video_id: id,
      title,
      description: null,
      channel_id: channel.channel_id,
      channel_title: channel.title,
      canonical_url: canonicalYouTubeUrl(id),
      thumbnail_url: thumbnail,
      published_at: null,
      source: "youtube_public",
    });
  }
  return videos;
}

function parseFeedXml(xml: string, maxVideos: number): YouTubeChannelVideo[] {
  const channelId = xml.match(/<yt:channelId>([^<]+)<\/yt:channelId>/)?.[1] ?? null;
  const channelTitle = decodeHtml(xml.match(/<name>([^<]+)<\/name>/)?.[1] ?? null);
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
  return entries.slice(0, maxVideos).map((entry) => {
    const id = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1] ?? "";
    return {
      youtube_video_id: id,
      title: decodeHtml(entry.match(/<title>([^<]*)<\/title>/)?.[1] ?? null),
      description: decodeHtml(entry.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1] ?? null),
      channel_id: channelId,
      channel_title: channelTitle || null,
      canonical_url: canonicalYouTubeUrl(id),
      thumbnail_url: decodeHtml(entry.match(/<media:thumbnail[^>]+url="([^"]+)"/)?.[1] ?? null) || null,
      published_at: entry.match(/<published>([^<]+)<\/published>/)?.[1] ?? null,
      source: "youtube_public" as const,
    };
  }).filter((video) => Boolean(video.youtube_video_id));
}

export async function listYouTubeChannelVideos(
  input: string,
  maxVideos = 20,
  options: PublicFetchOptions = {},
): Promise<YouTubeChannelVideo[]> {
  const limit = Math.max(1, Math.min(maxVideos, 20));
  const channel = await resolveYouTubeChannel(input, options);
  const normalized = normalizeYouTubeChannelInput(input);
  if (normalized.handle) {
    const html = await fetchText(`${YOUTUBE_ORIGIN}/${normalized.handle}/videos`, options);
    const videos = parseVideosHtml(html, channel, limit);
    if (videos.length > 0) return videos;
  }

  const feed = await fetchText(`${YOUTUBE_ORIGIN}/feeds/videos.xml?channel_id=${channel.channel_id}`, options);
  const videos = parseFeedXml(feed, limit);
  if (videos.length === 0) {
    throw new HttpError(404, "youtube_channel_videos_not_found", "Não encontrei vídeos públicos nesse canal.");
  }
  return videos;
}

async function fetchOembed(videoId: string, options: PublicFetchOptions): Promise<Record<string, unknown>> {
  const response = await (options.fetcher ?? fetch)(
    `${YOUTUBE_ORIGIN}/oembed?url=${encodeURIComponent(canonicalYouTubeUrl(videoId))}&format=json`,
  );
  if (!response.ok) return {};
  return await response.json().catch(() => ({})) as Record<string, unknown>;
}

export async function fetchYouTubeMetadata(
  videoIdOrUrl: string,
  options: PublicFetchOptions = {},
): Promise<YouTubeMetadata> {
  const videoId = extractYouTubeVideoId(videoIdOrUrl);
  if (!videoId) {
    throw new HttpError(400, "invalid_youtube_url", "Informe uma URL ou ID de vídeo do YouTube válido.");
  }
  const canonicalUrl = canonicalYouTubeUrl(videoId);
  const html = await fetchText(canonicalUrl, options);
  const oembed = await fetchOembed(videoId, options);

  const title = extractMeta(html, "og:title") ??
    (typeof oembed.title === "string" ? oembed.title : null);
  const description = extractMeta(html, "og:description") ??
    extractMeta(html, "description") ??
    null;
  const channelTitle = extractJsonString(html, "author") ??
    (typeof oembed.author_name === "string" ? oembed.author_name : null);
  const channelId = extractChannelId(html);
  const publishedAt = extractMeta(html, "datePublished") ??
    html.match(/"publishDate"\s*:\s*"([^"]+)"/)?.[1] ??
    null;
  const thumbnail = extractMeta(html, "og:image") ??
    (typeof oembed.thumbnail_url === "string" ? oembed.thumbnail_url : null);
  const keywords = extractMeta(html, "keywords")?.split(",").map((tag) => tag.trim()) ?? [];
  const tags = uniqueStrings([...keywords, ...inferTags(videoId, title, description, channelTitle)]);

  return {
    youtube_video_id: videoId,
    canonical_url: canonicalUrl,
    title,
    description,
    channel_id: channelId,
    channel_title: channelTitle,
    duration_seconds: null,
    published_at: publishedAt,
    thumbnails: thumbnail ? { default: thumbnail, high: thumbnail } : {},
    tags,
    language: "pt",
    metadata: {
      source: "youtube_public",
      public_sources: ["watch_html", "oembed"],
      oembed_author_url: typeof oembed.author_url === "string" ? oembed.author_url : null,
    },
  };
}
