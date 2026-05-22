import { defineMiddleware } from "astro:middleware";
import {
  createSupabaseAdminClient,
  getCurrentUser,
  getMembership,
  hasActiveMembership,
  isAdminEmail,
  isSupabaseConfigured,
  protectedPrefixes,
} from "@/lib/auth";

const deviceCookie = "tr_device_id";

function isProtectedPath(pathname: string) {
  return protectedPrefixes.some(prefix => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix));
}

function isAdminPath(pathname: string) {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

async function recordDevice(userId: string, deviceId: string, request: Request, limit: number) {
  const admin = createSupabaseAdminClient();
  if (!admin) return { allowed: true };

  const userAgent = request.headers.get("user-agent") ?? "";
  const forwardedFor = request.headers.get("x-forwarded-for") ?? "";
  const ip = forwardedFor.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "";

  await admin.from("user_devices").upsert(
    {
      user_id: userId,
      device_id: deviceId,
      user_agent: userAgent.slice(0, 500),
      ip_address: ip,
      last_seen_at: new Date().toISOString(),
      revoked_at: null,
    },
    { onConflict: "user_id,device_id" }
  );

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data } = await admin
    .from("user_devices")
    .select("device_id")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .gte("last_seen_at", since);

  const activeDeviceCount = new Set((data ?? []).map(row => row.device_id)).size;
  return { allowed: activeDeviceCount <= limit, activeDeviceCount };
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;
  const needsAuth = isProtectedPath(pathname) || isAdminPath(pathname);

  if (!needsAuth || pathname.startsWith("/api/") || pathname.startsWith("/auth/")) {
    return next();
  }

  if (!isSupabaseConfigured()) {
    return next();
  }

  const { user } = await getCurrentUser(context);
  if (!user) {
    const loginUrl = new URL("/login/", context.url);
    loginUrl.searchParams.set("next", pathname);
    return context.redirect(loginUrl.toString());
  }

  if (isAdminPath(pathname)) {
    if (!isAdminEmail(user.email)) return context.redirect("/settings/?admin=denied");
    return next();
  }

  const membership = await getMembership(user.id, user.email);
  if (!hasActiveMembership(membership)) {
    return context.redirect("/settings/?membership=required");
  }

  let deviceId = context.cookies.get(deviceCookie)?.value;
  let shouldSetDeviceCookie = false;
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    shouldSetDeviceCookie = true;
  }

  if (shouldSetDeviceCookie) {
    context.cookies.set(deviceCookie, deviceId, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: context.url.protocol === "https:",
      maxAge: 60 * 60 * 24 * 365,
    });
  }

  const result = await recordDevice(user.id, deviceId, context.request, membership.deviceLimit);
  if (!result.allowed) {
    return context.redirect("/settings/?device_limit=1");
  }

  return next();
});
