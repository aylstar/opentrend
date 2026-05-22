import type { APIRoute } from "astro";
import { accessCodeCookie, createSupabaseAdminClient, isAdminRequest, normalizeCode } from "@/lib/auth";

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
  const deviceId = String(body?.deviceId ?? "").trim();
  const requestedCode = normalizeCode(body?.code);
  const code = isAdminRequest(context) ? requestedCode : normalizeCode(context.cookies.get(accessCodeCookie)?.value);
  if (!code || !deviceId) return json({ error: "缺少激活码或设备 ID" }, 400);

  const { error } = await admin
    .from("code_devices")
    .update({ revoked_at: new Date().toISOString() })
    .eq("code", code)
    .eq("device_id", deviceId);

  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
};

