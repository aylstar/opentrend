import type { APIRoute } from "astro";
import { createSupabaseAdminClient, getCurrentUser, isAdminEmail } from "@/lib/auth";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function randomPart(length = 4) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  for (const byte of bytes) value += alphabet[byte % alphabet.length];
  return value;
}

function makeCode(prefix: string) {
  return `${prefix}-${randomPart()}-${randomPart()}-${randomPart()}`;
}

export const GET: APIRoute = async context => {
  const { user } = await getCurrentUser(context);
  if (!isAdminEmail(user?.email)) return json({ error: "无权限" }, 403);

  const admin = createSupabaseAdminClient();
  if (!admin) return json({ error: "服务端未配置 SUPABASE_SERVICE_ROLE_KEY" }, 500);

  const { data, error } = await admin
    .from("activation_codes")
    .select("code,plan,duration_days,status,order_no,used_at,created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) return json({ error: error.message }, 500);
  return json({ codes: data ?? [] });
};

export const POST: APIRoute = async context => {
  const { user } = await getCurrentUser(context);
  if (!isAdminEmail(user?.email)) return json({ error: "无权限" }, 403);

  const admin = createSupabaseAdminClient();
  if (!admin) return json({ error: "服务端未配置 SUPABASE_SERVICE_ROLE_KEY" }, 500);

  const body = await context.request.json().catch(() => null);
  const plan = String(body?.plan ?? "monthly");
  const count = Math.min(Math.max(Number(body?.count ?? 1), 1), 200);
  const durationDays = Math.min(Math.max(Number(body?.durationDays ?? 30), 1), 3650);
  const orderNo = String(body?.orderNo ?? "").trim() || null;
  const prefix = plan === "yearly" ? "YEAR" : plan === "vip" ? "VIP" : plan === "team" ? "TEAM" : "OPEN";

  const rows = Array.from({ length: count }, () => ({
    code: makeCode(prefix),
    plan,
    duration_days: durationDays,
    order_no: orderNo,
    status: "active",
    created_by: user?.id,
  }));

  const { data, error } = await admin.from("activation_codes").insert(rows).select("code,plan,duration_days");
  if (error) return json({ error: error.message }, 500);

  return json({ codes: data ?? [] });
};

