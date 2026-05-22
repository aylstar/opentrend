import type { APIRoute } from "astro";
import { createSupabaseAdminClient, getCurrentUser } from "@/lib/auth";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export const POST: APIRoute = async context => {
  const { user } = await getCurrentUser(context);
  if (!user) return json({ error: "请先登录" }, 401);

  const admin = createSupabaseAdminClient();
  if (!admin) return json({ error: "服务端未配置 SUPABASE_SERVICE_ROLE_KEY" }, 500);

  const body = await context.request.json().catch(() => null);
  const deviceId = String(body?.deviceId ?? "").trim();
  if (!deviceId) return json({ error: "缺少设备 ID" }, 400);

  const { error } = await admin
    .from("user_devices")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .eq("device_id", deviceId);

  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
};

