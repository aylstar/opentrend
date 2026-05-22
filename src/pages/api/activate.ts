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
  const code = String(body?.code ?? "")
    .trim()
    .toUpperCase();
  if (!code) return json({ error: "请输入激活码" }, 400);

  const { data: activationCode, error: codeError } = await admin
    .from("activation_codes")
    .select("id,code,plan,duration_days,status,used_by,used_at")
    .eq("code", code)
    .maybeSingle();

  if (codeError) return json({ error: codeError.message }, 500);
  if (!activationCode || activationCode.status !== "active" || activationCode.used_by) {
    return json({ error: "激活码不存在、已使用或已失效" }, 400);
  }

  const { data: existing } = await admin
    .from("subscriptions")
    .select("expires_at")
    .eq("user_id", user.id)
    .maybeSingle();

  const now = Date.now();
  const currentExpiry = existing?.expires_at ? new Date(existing.expires_at).getTime() : 0;
  const start = Math.max(now, currentExpiry);
  const expiresAt = new Date(start + activationCode.duration_days * 24 * 60 * 60 * 1000).toISOString();
  const deviceLimit = activationCode.plan === "team" ? 5 : activationCode.plan === "vip" ? 3 : 2;

  const { error: subscriptionError } = await admin.from("subscriptions").upsert(
    {
      user_id: user.id,
      email: user.email,
      plan: activationCode.plan,
      status: "active",
      source: "activation_code",
      activation_code: code,
      expires_at: expiresAt,
      device_limit: deviceLimit,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (subscriptionError) return json({ error: subscriptionError.message }, 500);

  const { error: updateCodeError } = await admin
    .from("activation_codes")
    .update({
      status: "used",
      used_by: user.id,
      used_at: new Date().toISOString(),
    })
    .eq("id", activationCode.id)
    .is("used_by", null);

  if (updateCodeError) return json({ error: updateCodeError.message }, 500);

  return json({
    ok: true,
    plan: activationCode.plan,
    expiresAt,
    deviceLimit,
  });
};

