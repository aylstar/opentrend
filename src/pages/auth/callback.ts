import type { APIRoute } from "astro";
import { createSupabaseServerClient } from "@/lib/auth";

export const GET: APIRoute = async context => {
  const supabase = createSupabaseServerClient(context);
  const code = context.url.searchParams.get("code");
  const next = context.url.searchParams.get("next") ?? "/settings/";

  if (!supabase || !code) {
    return context.redirect(`/login/?next=${encodeURIComponent(next)}&error=callback`);
  }

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return context.redirect(`/login/?next=${encodeURIComponent(next)}&error=session`);
  }

  return context.redirect(next.startsWith("/") ? next : "/settings/");
};
