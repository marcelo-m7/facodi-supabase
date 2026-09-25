import { HttpError } from "./v2_http.ts";

function configuredSecretKeys(): string[] {
  const values: string[] = [];
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS")?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const value of Object.values(parsed)) {
        if (typeof value === "string" && value.trim()) {
          values.push(value.trim());
        }
      }
    } catch (_error) {
      throw new HttpError(
        500,
        "invalid_secret_configuration",
        "Supabase secret-key configuration is invalid.",
      );
    }
  }

  const fallback = Deno.env.get("SUPABASE_SECRET_KEY")?.trim();
  if (fallback) values.push(fallback);

  return [...new Set(values)];
}

export function requireSecretApiKey(req: Request): string {
  const provided = req.headers.get("apikey")?.trim();
  if (!provided) {
    throw new HttpError(401, "unauthorized", "Missing Supabase secret API key.");
  }

  const accepted = configuredSecretKeys();
  if (!accepted.length || !accepted.includes(provided)) {
    throw new HttpError(401, "unauthorized", "Invalid Supabase secret API key.");
  }

  return provided;
}

export function optionalGeminiApiKey(req: Request): string | null {
  return (
    Deno.env.get("GEMINI_API_KEY")?.trim() ||
    req.headers.get("x-facodi-gemini-key")?.trim() ||
    null
  );
}
