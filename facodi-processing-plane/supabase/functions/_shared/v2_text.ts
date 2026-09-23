export function normalizeWhitespace(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function stripHtml(value: string | null | undefined): string {
  return normalizeWhitespace(
    String(value ?? "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">"),
  );
}

export function normalizeForSearch(value: string | null | undefined): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function slugify(value: string | null | undefined, fallback = "item"): string {
  const normalized = normalizeForSearch(value)
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function firstSubstantialParagraph(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    const text = stripHtml(value);
    const parts = text.split(/(?:\n|\.\s+)/).map(normalizeWhitespace);
    const found = parts.find((part) => part.length >= 80);
    if (found) {
      return found.length > 500 ? `${found.slice(0, 497)}...` : found;
    }
  }
  return null;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(normalizeWhitespace(text).length / 4));
}

export function splitText(text: string, maxChars = 1800): string[] {
  const clean = normalizeWhitespace(text);
  if (!clean) {
    return [];
  }
  if (clean.length <= maxChars) {
    return [clean];
  }

  const sentences = clean.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if ((current + " " + sentence).trim().length > maxChars && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = `${current} ${sentence}`.trim();
    }
  }
  if (current) {
    chunks.push(current.trim());
  }
  return chunks;
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => normalizeWhitespace(value))
        .filter((value) => value.length > 0),
    ),
  );
}
