import { createClient } from "@supabase/supabase-js";
import type { APIContext } from "astro";

export type PassStatus = "none" | "active" | "expired" | "disabled";

export type AccessPass = {
  code: string;
  plan: string;
  status: PassStatus;
  expiresAt: string | null;
  deviceLimit: number;
};

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
const supabaseServiceRoleKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;
const adminToken = import.meta.env.ADMIN_TOKEN;

export const accessCodeCookie = "tr_access_code";
export const deviceCookie = "tr_device_id";

export const protectedPrefixes = [
  "/news/",
  "/finance/",
  "/youtube/",
  "/trends/",
  "/projects/",
  "/library/",
];

export function isSupabaseConfigured() {
  return Boolean(supabaseUrl && supabaseServiceRoleKey);
}

export function createSupabaseAdminClient() {
  if (!isSupabaseConfigured()) return null;
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export function normalizeCode(value?: string | null) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

export function planDeviceLimit(plan: string) {
  if (plan === "team") return 5;
  if (plan === "vip") return 3;
  return 2;
}

export async function getAccessPass(code?: string | null): Promise<AccessPass | null> {
  const normalizedCode = normalizeCode(code);
  const admin = createSupabaseAdminClient();
  if (!admin || !normalizedCode) return null;

  const { data } = await admin
    .from("activation_codes")
    .select("code,plan,status,expires_at,device_limit")
    .eq("code", normalizedCode)
    .maybeSingle();

  if (!data) return null;

  const expired =
    data.expires_at && new Date(data.expires_at).getTime() < Date.now();

  return {
    code: data.code,
    plan: data.plan ?? "monthly",
    status: data.status === "disabled" ? "disabled" : expired ? "expired" : "active",
    expiresAt: data.expires_at ?? null,
    deviceLimit: data.device_limit ?? planDeviceLimit(data.plan ?? "monthly"),
  };
}

export function hasActivePass(pass: AccessPass | null) {
  return pass?.status === "active";
}

export function isAdminRequest(context: Pick<APIContext, "cookies" | "url" | "request">) {
  if (!adminToken) return false;
  const cookieToken = context.cookies.get("tr_admin_token")?.value;
  const queryToken = context.url.searchParams.get("token");
  const headerToken = context.request.headers.get("x-admin-token");
  return [cookieToken, queryToken, headerToken].some(token => token === adminToken);
}

export function setAccessCookies(context: Pick<APIContext, "cookies" | "url">, code: string, deviceId: string) {
  const secure = context.url.protocol === "https:";
  context.cookies.set(accessCodeCookie, normalizeCode(code), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: 60 * 60 * 24 * 365,
  });
  context.cookies.set(deviceCookie, deviceId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: 60 * 60 * 24 * 365,
  });
}

