import type { APIRoute } from "astro";
import {
  createSupabaseAdminClient,
  deviceCookie,
  normalizeCode,
  planDeviceLimit,
  setAccessCookies,
} from "@/lib/auth";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export const POST: APIRoute = async context => {
  const admin = createSupabaseAdminClient();
  if (!admin) return json({ error: "账户系统未配置" }, 500);

  const body = await context.request.json().catch(() => null);
  const code = normalizeCode(body?.code);
  if (!code) return json({ error: "请输入激活码" }, 400);

  const { data: activationCode, error: codeError } = await admin
    .from("activation_codes")
    .select("id,code,plan,duration_days,status,activated_at,expires_at,device_limit")
    .eq("code", code)
    .maybeSingle();

  if (codeError) return json({ error: codeError.message }, 500);
  if (!activationCode || activationCode.status === "disabled") {
    return json({ error: "激活码不存在或已失效" }, 400);
  }

  const now = Date.now();
  const existingExpiry = activationCode.expires_at ? new Date(activationCode.expires_at).getTime() : 0;
  if (existingExpiry && existingExpiry < now) {
    return json({ error: "激活码已过期" }, 400);
  }

  const expiresAt =
    activationCode.expires_at ??
    new Date(now + activationCode.duration_days * 24 * 60 * 60 * 1000).toISOString();
  const deviceLimit = activationCode.device_limit ?? planDeviceLimit(activationCode.plan);
  const deviceId = context.cookies.get(deviceCookie)?.value ?? crypto.randomUUID();

  const userAgent = context.request.headers.get("user-agent") ?? "";
  const forwardedFor = context.request.headers.get("x-forwarded-for") ?? "";
  const ip = forwardedFor.split(",")[0]?.trim() || context.request.headers.get("x-real-ip") || "";

  await admin
    .from("activation_codes")
    .update({
      status: "active",
      activated_at: activationCode.activated_at ?? new Date().toISOString(),
      expires_at: expiresAt,
      device_limit: deviceLimit,
      last_seen_at: new Date().toISOString(),
    })
    .eq("id", activationCode.id);

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

  const { data: devices } = await admin
    .from("code_devices")
    .select("device_id")
    .eq("code", code)
    .is("revoked_at", null);

  const activeDeviceCount = new Set((devices ?? []).map(row => row.device_id)).size;
  if (activeDeviceCount > deviceLimit) {
    return json({ error: `该激活码已超过 ${deviceLimit} 台设备上限，请联系管理员重置` }, 403);
  }

  setAccessCookies(context, code, deviceId);

  return json({
    ok: true,
    code,
    plan: activationCode.plan,
    expiresAt,
    deviceLimit,
  });
};

