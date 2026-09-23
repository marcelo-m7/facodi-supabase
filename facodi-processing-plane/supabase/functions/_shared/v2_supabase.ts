import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.105.4";
import { HttpError } from "./v2_http.ts";

export type AdminClient = SupabaseClient;

export function env(name: string, fallbackNames: string[] = []): string {
  const names = [name, ...fallbackNames];
  for (const candidate of names) {
    const value = Deno.env.get(candidate)?.trim();
    if (value) {
      return value;
    }
  }
  throw new HttpError(500, "missing_environment", `Missing ${name} environment variable.`);
}

export function optionalEnv(name: string, fallbackNames: string[] = []): string | null {
  const names = [name, ...fallbackNames];
  for (const candidate of names) {
    const value = Deno.env.get(candidate)?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

export function createAdminClient(): AdminClient {
  const url = env("SUPABASE_URL");
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY", ["SUPABASE_SECRET_KEY"]);

  return createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      headers: {
        "x-application-name": "facodi-backend-v2",
      },
    },
  });
}

export function facodi(client: AdminClient) {
  const schema = optionalEnv("FACODI_DB_SCHEMA", ["SUPABASE_DB_SCHEMA"]) ?? "facodi";
  return client.schema(schema);
}

export function unwrap<T>(result: { data: T | null; error: { message: string } | null }): T {
  if (result.error) {
    throw new HttpError(500, "supabase_error", result.error.message);
  }
  if (result.data === null) {
    throw new HttpError(404, "not_found", "Expected row was not found.");
  }
  return result.data;
}

export function unwrapMaybe<T>(result: {
  data: T | null;
  error: { message: string } | null;
}): T | null {
  if (result.error) {
    throw new HttpError(500, "supabase_error", result.error.message);
  }
  return result.data;
}
