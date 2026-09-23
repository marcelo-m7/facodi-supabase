import type { AdminClient } from "./v2_supabase.ts";
import { createAdminClient, optionalEnv } from "./v2_supabase.ts";
import { HttpError } from "./v2_http.ts";

export type AuthMode = "user" | "editor" | "secret";

export interface AuthContext {
  mode: AuthMode;
  userId: string | null;
  role: "user" | "editor" | "admin" | "service";
}

function getBearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return null;
  }
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function hasEditorRole(
  appMetadata: Record<string, unknown> | null | undefined,
): "editor" | "admin" | null {
  const role = typeof appMetadata?.role === "string" ? appMetadata.role : null;
  const facodiRole = typeof appMetadata?.facodi_role === "string" ? appMetadata.facodi_role : null;
  const roles = Array.isArray(appMetadata?.roles) ? appMetadata.roles : [];
  const normalized = [role, facodiRole, ...roles]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());

  if (normalized.includes("admin")) {
    return "admin";
  }
  if (normalized.includes("editor")) {
    return "editor";
  }
  return null;
}

function validateSharedSecret(req: Request): boolean {
  const configured = optionalEnv("FACODI_WEBHOOK_SECRET");
  if (!configured) {
    return false;
  }
  const provided = req.headers.get("x-facodi-webhook-secret")?.trim();
  return Boolean(provided && provided === configured);
}

async function getProfileEditorRole(
  admin: AdminClient,
  userId: string,
): Promise<"user" | "editor" | "admin" | null> {
  const { data, error } = await admin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle<{ role: string | null }>();

  if (error) {
    return null;
  }

  const role = typeof data?.role === "string" ? data.role.toLowerCase() : null;
  if (role === "admin") {
    return "admin";
  }
  if (role === "editor") {
    return "editor";
  }
  if (role === "user") {
    return "user";
  }
  return null;
}

export async function requireEditorAuth(
  req: Request,
  admin: AdminClient = createAdminClient(),
): Promise<AuthContext> {
  const auth = await requireUserAuth(req, admin);

  if (auth.role !== "editor" && auth.role !== "admin") {
    throw new HttpError(
      403,
      "forbidden",
      "Editor or admin role required (app_metadata or profiles.role).",
    );
  }

  return {
    ...auth,
    role: auth.role,
  };
}

export async function requireUserAuth(
  req: Request,
  admin: AdminClient = createAdminClient(),
): Promise<AuthContext> {
  const token = getBearer(req);
  if (!token) {
    throw new HttpError(401, "unauthorized", "Missing bearer token.");
  }

  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) {
    throw new HttpError(401, "unauthorized", "Invalid bearer token.");
  }

  const appMetadataRole = hasEditorRole((data.user.app_metadata ?? {}) as Record<string, unknown>);
  const profileRole = await getProfileEditorRole(admin, data.user.id);
  const role = appMetadataRole ?? profileRole ?? "user";

  return {
    mode: role === "editor" || role === "admin" ? "editor" : "user",
    userId: data.user.id,
    role,
  };
}

export async function requireInternalAuth(
  req: Request,
  admin: AdminClient = createAdminClient(),
): Promise<AuthContext> {
  if (validateSharedSecret(req)) {
    return {
      mode: "secret",
      userId: null,
      role: "service",
    };
  }

  return await requireEditorAuth(req, admin);
}
