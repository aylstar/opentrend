import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import type { APIContext } from "astro";

export type SubscriptionStatus = "free" | "active" | "expired" | "banned";

export type Membership = {
  userId: string;
  email: string | null;
  plan: string;
  status: SubscriptionStatus;
  expiresAt: string | null;
  deviceLimit: number;
};

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;

export const protectedPrefixes = [
  "/news/",
  "/finance/",
  "/youtube/",
  "/trends/",
  "/projects/",
  "/library/",
];

export function isSupabaseConfigured() {
  return Boolean(supabaseUrl && supabaseAnonKey);
}

export function isServiceRoleConfigured() {
  return Boolean(supabaseUrl && supabaseServiceRoleKey);
}

function parseCookieHeader(cookieHeader: string | null) {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(";")
    .map(cookie => {
      const [name, ...valueParts] = cookie.trim().split("=");
      return { name, value: decodeURIComponent(valueParts.join("=")) };
    })
    .filter(cookie => cookie.name);
}

export function createSupabaseServerClient(context: Pick<APIContext, "cookies" | "request">) {
  if (!isSupabaseConfigured()) return null;

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return parseCookieHeader(context.request.headers.get("cookie"));
      },
      setAll(cookieList) {
        cookieList.forEach(cookie => {
          context.cookies.set(cookie.name, cookie.value, {
            ...cookie.options,
            path: cookie.options?.path ?? "/",
          });
        });
      },
    },
  });
}

export function createSupabaseAdminClient() {
  if (!isServiceRoleConfigured()) return null;
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export async function getCurrentUser(context: Pick<APIContext, "cookies" | "request">) {
  const supabase = createSupabaseServerClient(context);
  if (!supabase) return { supabase: null, user: null };

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { supabase, user };
}

export async function getMembership(userId: string, email?: string | null): Promise<Membership> {
  const admin = createSupabaseAdminClient();
  const fallback: Membership = {
    userId,
    email: email ?? null,
    plan: "free",
    status: "free",
    expiresAt: null,
    deviceLimit: 1,
  };

  if (!admin) return fallback;

  const { data } = await admin
    .from("subscriptions")
    .select("plan,status,expires_at,device_limit")
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) return fallback;

  const expired =
    data.expires_at && data.status === "active" && new Date(data.expires_at).getTime() < Date.now();

  return {
    userId,
    email: email ?? null,
    plan: data.plan ?? "free",
    status: expired ? "expired" : (data.status ?? "free"),
    expiresAt: data.expires_at ?? null,
    deviceLimit: data.device_limit ?? 1,
  };
}

export function hasActiveMembership(membership: Membership) {
  return membership.status === "active";
}

export function getAdminEmails() {
  return String(import.meta.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email?: string | null) {
  if (!email) return false;
  return getAdminEmails().includes(email.toLowerCase());
}
