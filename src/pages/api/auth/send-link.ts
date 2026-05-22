import type { APIRoute } from "astro";
import { createSupabaseServerClient } from "@/lib/auth";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export const POST: APIRoute = async context => {
  const supabase = createSupabaseServerClient(context);
  if (!supabase) return json({ error: "账户系统未配置" }, 500);

  const body = await context.request.json().catch(() => null);
  const email = String(body?.email ?? "").trim();
  const next = String(body?.next ?? "/settings/");
  if (!email) return json({ error: "请输入邮箱" }, 400);

  const redirectTo = `${context.url.origin}/auth/callback/?next=${encodeURIComponent(
    next.startsWith("/") ? next : "/settings/"
  )}`;
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: redirectTo,
    },
  });

  if (error) return json({ error: error.message }, 400);
  return json({ ok: true });
};

