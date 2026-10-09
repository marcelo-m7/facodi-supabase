import { extractCanonicalDocument } from "../workers/canonical/document.ts";
import { HttpError } from "../supabase/functions/_shared/http.ts";

const python = Deno.env.get("FACODI_TEST_PYTHON") ?? "python3";
const source = Deno.env.get("FACODI_TEST_API_SOURCE");
if (!source) throw new Error("FACODI_TEST_API_SOURCE must identify the exact converter source");
const converter = { python, script: `${source}/facodi_api/core/ingestion/document_transport.py`, timeout: 30000 };

async function denied(content: Uint8Array, extension: string, code: string): Promise<void> {
  try { await extractCanonicalDocument(content, extension, converter); }
  catch (error) { if (error instanceof HttpError && error.code === code) return; throw error; }
  throw new Error("Invalid input was accepted");
}

Deno.test("isolated converter preserves full bounded text without truncation", async () => {
  const text = "Educational evidence. ".repeat(8000);
  if (await extractCanonicalDocument(new TextEncoder().encode(text), ".txt", converter) !== text) {
    throw new Error("Text changed at conversion boundary");
  }
});

Deno.test("isolated converter enforces source and text bounds before accepting evidence", async () => {
  await denied(new Uint8Array(), ".txt", "DOCUMENT_NO_CONTENT");
  await denied(new Uint8Array(2 * 1024 * 1024 + 1), ".pdf", "DOCUMENT_TOO_LARGE");
  await denied(new TextEncoder().encode("x".repeat(262145)), ".txt", "DOCUMENT_TEXT_TOO_LARGE");
  await denied(new TextEncoder().encode("not a PDF"), ".pdf", "DOCUMENT_INVALID_FORMAT");
  await denied(new TextEncoder().encode("unknown executable"), ".exe", "DOCUMENT_INVALID_FORMAT");
});

Deno.test("isolated converter parses real PDF and DOCX with the existing pinned parser", async () => {
  for (const extension of [".pdf", ".docx"]) {
    const script = extension === ".docx" ?
      'import io,sys; from docx import Document; stream=io.BytesIO(); document=Document(); document.add_paragraph("Native document evidence"); document.save(stream); sys.stdout.buffer.write(stream.getvalue())' :
      'import io,sys; from pypdf import PdfWriter; from pypdf.generic import DictionaryObject,NameObject,DecodedStreamObject; writer=PdfWriter(); page=writer.add_blank_page(200,200); font=DictionaryObject({NameObject("/Type"):NameObject("/Font"),NameObject("/Subtype"):NameObject("/Type1"),NameObject("/BaseFont"):NameObject("/Helvetica")}); page[NameObject("/Resources")]=DictionaryObject({NameObject("/Font"):DictionaryObject({NameObject("/F1"):writer._add_object(font)})}); stream=DecodedStreamObject(); stream.set_data(b"BT /F1 12 Tf 10 100 Td (Native document evidence) Tj ET"); page[NameObject("/Contents")]=writer._add_object(stream); output=io.BytesIO(); writer.write(output); sys.stdout.buffer.write(output.getvalue())';
    const fixture = await new Deno.Command(python, { args: ["-I", "-c", script], clearEnv: true,
      env: { LANG: "C.UTF-8", PATH: "/usr/local/bin:/usr/bin:/bin" }, stdout: "piped", stderr: "null" }).output();
    if (!fixture.success) throw new Error("Real parser fixture generation failed");
    const text = await extractCanonicalDocument(fixture.stdout, extension, converter);
    if (!text.includes("Native document evidence")) throw new Error("Parser lost document evidence");
  }
});

Deno.test("isolated converter never inherits worker credentials or Python configuration", async () => {
  const directory = await Deno.makeTempDir({ prefix: "facodi-converter-" });
  const key = Deno.env.get("SUPABASE_SECRET_KEY");
  try {
    Deno.env.set("SUPABASE_SECRET_KEY", "disposable-test-sentinel");
    const script = `${directory}/environment.py`;
    await Deno.writeTextFile(script, 'import os,sys,json\nassert "SUPABASE_SECRET_KEY" not in os.environ\nassert sys.flags.isolated == 1\nprint(json.dumps({"text":"Credential-free conversion"}))\n');
    const text = await extractCanonicalDocument(new TextEncoder().encode("fixture"), ".txt", { ...converter, script });
    if (text !== "Credential-free conversion") throw new Error("Credential isolation failed");
  } finally {
    if (key === undefined) Deno.env.delete("SUPABASE_SECRET_KEY"); else Deno.env.set("SUPABASE_SECRET_KEY", key);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("isolated converter hard deadline terminates a stalled child without lingering processes", async () => {
  const directory = await Deno.makeTempDir({ prefix: "facodi-converter-" });
  const started = performance.now();
  try {
    const script = `${directory}/stalled.py`;
    await Deno.writeTextFile(script, "while True: pass\n");
    let timedOut = false;
    try { await extractCanonicalDocument(new TextEncoder().encode("fixture"), ".txt", { ...converter, script, timeout: 100 }); }
    catch (error) { timedOut = error instanceof HttpError && error.code === "DOCUMENT_TIMEOUT"; }
    if (!timedOut || performance.now() - started > 2000) throw new Error("Child deadline was not enforced");
  } finally { await Deno.remove(directory, { recursive: true }); }
});