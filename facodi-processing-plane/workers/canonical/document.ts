import { Buffer } from "node:buffer";
import { HttpError } from "../../supabase/functions/_shared/http.ts";

const SAFE_CODES = new Set(["DOCUMENT_TIMEOUT", "DOCUMENT_EXTRACTION_FAILED", "DOCUMENT_INVALID_OUTPUT",
  "DOCUMENT_INVALID_FORMAT", "DOCUMENT_TOO_LARGE", "DOCUMENT_NO_CONTENT", "DOCUMENT_TEXT_TOO_LARGE",
  "DOCUMENT_LIMIT_EXCEEDED", "DOCUMENT_EXPANSION_TOO_LARGE", "DOCUMENT_NO_TEXT"]);

export async function extractCanonicalDocument(content: Uint8Array, extension: string,
  converter = { python: "/usr/local/bin/python3", script: "/opt/facodi-api/facodi_api/core/ingestion/document_transport.py", timeout: 30000 }): Promise<string> {
  if (![".pdf", ".docx", ".txt", ".md"].includes(extension)) throw new HttpError(422, "DOCUMENT_INVALID_FORMAT");
  if (!content.length || content.length > 2 * 1024 * 1024) {
    throw new HttpError(422, content.length ? "DOCUMENT_TOO_LARGE" : "DOCUMENT_NO_CONTENT");
  }
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(converter.python, {
      args: ["-I", converter.script], clearEnv: true, env: { LANG: "C.UTF-8", PATH: "/usr/local/bin:/usr/bin:/bin" },
      stdin: "piped", stdout: "piped", stderr: "null",
    }).spawn();
  } catch (_error) { throw new HttpError(503, "DOCUMENT_EXTRACTION_FAILED"); }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill("SIGKILL"); } catch (_error) {}
  }, converter.timeout);
  try {
    const writer = child.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(JSON.stringify({ content: Buffer.from(content).toString("base64"), extension })));
      await writer.close();
    } finally { writer.releaseLock(); }
    const reader = child.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new HttpError(422, "DOCUMENT_INVALID_OUTPUT");
        }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const status = await child.status;
    if (timedOut) throw new HttpError(422, "DOCUMENT_TIMEOUT");
    if (!status.success) throw new HttpError(422, "DOCUMENT_EXTRACTION_FAILED");
    const output = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (output.error) throw new HttpError(422, SAFE_CODES.has(output.error) ? output.error : "DOCUMENT_EXTRACTION_FAILED");
    if (typeof output.text !== "string" || !output.text.trim() || new TextEncoder().encode(output.text).length > 262144) {
      throw new HttpError(422, "DOCUMENT_INVALID_OUTPUT");
    }
    return output.text;
  } catch (error) {
    if (timedOut) throw new HttpError(422, "DOCUMENT_TIMEOUT");
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, "DOCUMENT_EXTRACTION_FAILED");
  } finally {
    clearTimeout(timer);
    try { child.kill("SIGKILL"); } catch (_error) {}
    await child.status;
  }
}