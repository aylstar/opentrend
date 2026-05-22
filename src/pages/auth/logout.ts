import type { APIRoute } from "astro";
import { accessCodeCookie, deviceCookie } from "@/lib/auth";

export const POST: APIRoute = async context => {
  context.cookies.delete(accessCodeCookie, { path: "/" });
  context.cookies.delete(deviceCookie, { path: "/" });
  return context.redirect("/settings/");
};

