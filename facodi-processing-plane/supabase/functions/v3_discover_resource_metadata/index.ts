import {
  ensureMethod,
  HttpError,
  json,
  readJson,
  withHttp,
} from "../_shared/v2_http.ts";
import { requireSecretApiKey } from "../_shared/v3_auth.ts";
import { fetchResourceMetadata } from "../_shared/v3_youtube.ts";

interface MetadataRequest {
  source_url: string;
}

function requiredPublicUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "invalid_source_url", "source_url is required.");
  }

  const raw = value.trim().slice(0, 4096);
  let url: URL;
  try {
    url = new URL(raw);
  } catch (_error) {
    throw new HttpError(400, "invalid_source_url", "source_url must be a valid URL.");
  }

  if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
    throw new HttpError(
      400,
      "invalid_source_url",
      "source_url must use HTTP or HTTPS.",
    );
  }
  if (url.username || url.password) {
    throw new HttpError(
      400,
      "invalid_source_url",
      "source_url must not contain credentials.",
    );
  }
  return url.toString();
}

function compactLanguage(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace("_", "-");
  if (!normalized) return null;
  return normalized.slice(0, 32);
}

Deno.serve((req) =>
  withHttp(req, async () => {
    ensureMethod(req, "POST");
    requireSecretApiKey(req);

    const body = await readJson<MetadataRequest>(req);
    const sourceUrl = requiredPublicUrl(body.source_url);
    const metadata = await fetchResourceMetadata(sourceUrl);

    return json({
      success: true,
      metadata: {
        provider: metadata.provider,
        external_id: metadata.external_id,
        canonical_url: metadata.canonical_url,
        title: metadata.title?.slice(0, 500) ?? null,
        author_name: metadata.author_name?.slice(0, 300) ?? null,
        author_url: metadata.author_url,
        thumbnail_url: metadata.thumbnail_url,
        duration_seconds: metadata.duration_seconds,
        published_at: metadata.published_at,
        language: compactLanguage(metadata.language),
        metadata_source: metadata.metadata_source,
      },
    });
  })
);
