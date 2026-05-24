import { defineMiddleware } from "astro:middleware";
import {
  accessCodeCookie,
  accessSessionCookie,
  createSupabaseAdminClient,
  deviceCookie,
  getAccessPass,
  hasActivePass,
  isAdminRequest,
  protectedPrefixes,
  setAccessCookies,
  setAccessSessionCookie,
  verifyAccessSession,
} from "@/lib/auth";

function isProtectedPath(pathname: string) {
  return protectedPrefixes.some(prefix => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix));
}

function isAdminPath(pathname: string) {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

async function recordDevice(code: string, deviceId: string, request: Request, limit: number) {
  const admin = createSupabaseAdminClient();
  if (!admin) return { allowed: true };

  const userAgent = request.headers.get("user-agent") ?? "";
  const forwardedFor = request.headers.get("x-forwarded-for") ?? "";
  const ip = forwardedFor.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "";

  await admin.from("code_devices").upsert(
    {
      code,
      device_id: deviceId,
      user_agent: userAgent.slice(0, 500),
      ip_address: ip,
      last_seen_at: new Date().toISOString(),
      revoked_at: null,
    },
    { onConflict: "code,device_id" }
  );

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await admin
    .from("code_devices")
    .select("device_id")
    .eq("code", code)
    .is("revoked_at", null)
    .gte("last_seen_at", since);

  const activeDeviceCount = new Set((data ?? []).map(row => row.device_id)).size;
  return { allowed: activeDeviceCount <= limit, activeDeviceCount };
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  if (pathname.startsWith("/api/")) return next();

  if (isAdminPath(pathname)) {
    if (isAdminRequest(context)) {
      const token = context.url.searchParams.get("token");
      if (token) {
        context.cookies.set("tr_admin_token", token, {
          path: "/",
          httpOnly: true,
          sameSite: "lax",
          secure: context.url.protocol === "https:",
          maxAge: 60 * 60 * 24 * 30,
        });
        return context.redirect("/admin/");
      }
      return next();
    }
    return next();
  }

  if (!isProtectedPath(pathname)) return next();

  if (import.meta.env.DEV && !createSupabaseAdminClient()) {
    return next();
  }

  const code = context.cookies.get(accessCodeCookie)?.value;
  const session = await verifyAccessSession(context.cookies.get(accessSessionCookie)?.value);
  if (session && session.code === code) {
    const response = await next();
    response.headers.set("cache-control", "private, max-age=60, stale-while-revalidate=300");
    return response;
  }

  const pass = await getAccessPass(code);
  if (!pass || !hasActivePass(pass)) {
    return context.redirect("/settings/?membership=required");
  }

  let deviceId = context.cookies.get(deviceCookie)?.value;
  if (!deviceId) deviceId = crypto.randomUUID();
  setAccessCookies(context, pass.code, deviceId);

  const result = await recordDevice(pass.code, deviceId, context.request, pass.deviceLimit);
  if (!result.allowed) {
    return context.redirect("/settings/?device_limit=1");
  }

  await setAccessSessionCookie(context, pass);

  const response = await next();
  response.headers.set("cache-control", "private, max-age=60, stale-while-revalidate=300");
  return response;
});
