export type JsonObject = Record<string, unknown>;

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message?: string, details?: unknown) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-facodi-webhook-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

export function ensureMethod(req: Request, methods: string | string[]): void {
  const allowed = Array.isArray(methods) ? methods : [methods];
  if (!allowed.includes(req.method)) {
    throw new HttpError(405, "method_not_allowed", `Allowed methods: ${allowed.join(", ")}`);
  }
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch (_error) {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

export async function optionalJson<T>(req: Request): Promise<T | null> {
  if (req.method === "GET") {
    return null;
  }
  const raw = await req.text();
  if (!raw.trim()) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (_error) {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json(
      {
        success: false,
        error: error.code,
        message: error.message,
        details: error.details ?? undefined,
      },
      error.status,
    );
  }

  console.error(error);
  return json(
    {
      success: false,
      error: "unexpected_error",
      message: "Unexpected server error.",
    },
    500,
  );
}

export async function withHttp(
  req: Request,
  handler: () => Promise<Response> | Response,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    return await handler();
  } catch (error) {
    return errorResponse(error);
  }
}

export function assertString(value: unknown, code: string, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, code, message);
  }
  return value.trim();
}
