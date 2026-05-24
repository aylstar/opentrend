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
export const accessSessionCookie = "tr_access_session";
const sessionMaxAgeSeconds = 60 * 60 * 12;

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

function getSessionSecret() {
  return supabaseServiceRoleKey || adminToken || "";
}

function toBase64Url(value: ArrayBuffer | string) {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : new Uint8Array(value);
  let binary = "";
  bytes.forEach(byte => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return atob(padded);
}

async function hmac(value: string) {
  const secret = getSessionSecret();
  if (!secret) return "";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return toBase64Url(signature);
}

export async function createAccessSession(pass: AccessPass) {
  const now = Date.now();
  const absoluteExpiry = pass.expiresAt ? new Date(pass.expiresAt).getTime() : now + sessionMaxAgeSeconds * 1000;
  const exp = Math.min(absoluteExpiry, now + sessionMaxAgeSeconds * 1000);
  const payload = toBase64Url(JSON.stringify({ code: pass.code, exp, deviceLimit: pass.deviceLimit }));
  const signature = await hmac(payload);
  if (!signature) return "";
  return `${payload}.${signature}`;
}

export async function verifyAccessSession(value?: string | null) {
  if (!value) return null;
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = await hmac(payload);
  if (!expected || expected !== signature) return null;
  const parsed = JSON.parse(fromBase64Url(payload)) as { code?: string; exp?: number; deviceLimit?: number };
  if (!parsed.code || !parsed.exp || parsed.exp < Date.now()) return null;
  return {
    code: normalizeCode(parsed.code),
    deviceLimit: parsed.deviceLimit ?? 2,
    expiresAt: new Date(parsed.exp).toISOString(),
  };
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

export async function setAccessSessionCookie(context: Pick<APIContext, "cookies" | "url">, pass: AccessPass) {
  const session = await createAccessSession(pass);
  if (!session) return;
  context.cookies.set(accessSessionCookie, session, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: context.url.protocol === "https:",
    maxAge: sessionMaxAgeSeconds,
  });
}
