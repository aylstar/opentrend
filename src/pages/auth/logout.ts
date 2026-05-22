import type { APIRoute } from "astro";
import { createSupabaseServerClient } from "@/lib/auth";

export const POST: APIRoute = async context => {
  const supabase = createSupabaseServerClient(context);
  await supabase?.auth.signOut();
  context.cookies.delete("tr_device_id", { path: "/" });
  return context.redirect("/login/");
};
