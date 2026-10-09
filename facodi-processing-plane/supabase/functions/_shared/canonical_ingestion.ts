import {
  fetchTranscript, toPlainText, type FetchParams,
  YoutubeTranscriptDisabledError, YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError, YoutubeTranscriptInvalidLangError,
  YoutubeTranscriptTooManyRequestError, YoutubeTranscriptVideoUnavailableError,
} from "npm:youtube-transcript-plus@2.0.3";
import { HttpError } from "./http.ts";
import { extractYouTubeVideoId, type ResourceMetadata } from "./v3_youtube.ts";

export interface AcquiredMetadata extends ResourceMetadata {
  document_data?: {
    text_content: string;
    language: string;
    source_url: string;
    extraction_provider: string;
    extraction_version: string;
  };
}

export async function acquireCanonicalYoutube(
  request: { source_url: string; language: string; title: string },
  transport: typeof fetch = fetch,
): Promise<AcquiredMetadata> {
  const videoId = extractYouTubeVideoId(request.source_url);
  if (!videoId) throw new HttpError(400, "CANONICAL_INPUT_CHANGED");
  const signal = AbortSignal.timeout(30000);
  const boundedFetch = async (params: FetchParams, path: string): Promise<Response> => {
    const url = new URL(params.url);
    if (url.protocol !== "https:" || url.hostname !== "www.youtube.com" || url.port ||
        url.username || url.password || url.pathname !== path ||
        (path !== "/youtubei/v1/player" && url.searchParams.get("v") !== videoId) ||
        (path === "/youtubei/v1/player" && JSON.parse(params.body ?? "{}").videoId !== videoId)) {
      throw new HttpError(400, "CANONICAL_INPUT_CHANGED");
    }
    const response = await transport(url, {
      method: params.method ?? "GET", body: params.body,
      headers: { ...params.headers, "User-Agent": params.userAgent ?? "FACODI", "Accept-Language": request.language },
      redirect: "error", signal,
    });
    if ([403, 429].includes(response.status)) throw new HttpError(422, "YOUTUBE_IP_BLOCKED");
    if ([404, 410].includes(response.status)) throw new HttpError(422, "YOUTUBE_VIDEO_UNAVAILABLE");
    if (!response.ok) throw new HttpError(503, "canonical_source_unavailable");
    const reader = response.body?.getReader();
    if (!reader) throw new HttpError(422, "YOUTUBE_TRANSCRIPTS_DISABLED");
    const chunks: ArrayBuffer[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 2097152) throw new HttpError(413, "INPUT_BUDGET_EXHAUSTED");
        chunks.push(new Uint8Array(part.value).buffer);
      }
    } finally {
      await reader.cancel();
    }
    return new Response(new Blob(chunks), { headers: response.headers });
  };
  try {
    const result = await fetchTranscript(videoId, {
      lang: request.language || undefined, retries: 0, signal, videoDetails: true,
      videoFetch: (params) => boundedFetch(params, "/watch"),
      playerFetch: (params) => boundedFetch(params, "/youtubei/v1/player"),
      transcriptFetch: (params) => boundedFetch(params, "/api/timedtext"),
    });
    const text = toPlainText(result.segments, " ").trim();
    if (!text) throw new HttpError(422, "YOUTUBE_TRANSCRIPTS_DISABLED");
    if (new TextEncoder().encode(text).length > 12000) throw new HttpError(413, "INPUT_BUDGET_EXHAUSTED");
    if (result.videoDetails.videoId !== videoId) throw new HttpError(400, "CANONICAL_INPUT_CHANGED");
    const language = result.segments[0].lang;
    return {
      provider: "youtube", external_id: videoId, canonical_url: request.source_url,
      title: result.videoDetails.title || request.title, description: null,
      author_name: result.videoDetails.author || null, author_url: null, thumbnail_url: null,
      duration_seconds: Number.isFinite(result.videoDetails.lengthSeconds) ? result.videoDetails.lengthSeconds : null,
      published_at: null, language, metadata_source: "youtube-transcript-plus@2.0.3",
      document_data: { text_content: text, language, source_url: request.source_url,
        extraction_provider: "youtube-transcript-plus", extraction_version: "2.0.3" },
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof YoutubeTranscriptTooManyRequestError) throw new HttpError(422, "YOUTUBE_IP_BLOCKED");
    if (error instanceof YoutubeTranscriptVideoUnavailableError) throw new HttpError(422, "YOUTUBE_VIDEO_UNAVAILABLE");
    if (error instanceof YoutubeTranscriptNotAvailableLanguageError || error instanceof YoutubeTranscriptInvalidLangError) {
      throw new HttpError(422, "YOUTUBE_LANGUAGE_UNAVAILABLE");
    }
    if (error instanceof YoutubeTranscriptDisabledError || error instanceof YoutubeTranscriptNotAvailableError) {
      throw new HttpError(422, "YOUTUBE_TRANSCRIPTS_DISABLED");
    }
    throw new HttpError(503, "canonical_source_unavailable");
  }
}