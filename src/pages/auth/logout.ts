import type { APIRoute } from "astro";
import { accessCodeCookie, accessSessionCookie, deviceCookie } from "@/lib/auth";

export const POST: APIRoute = async context => {
  context.cookies.delete(accessCodeCookie, { path: "/" });
  context.cookies.delete(deviceCookie, { path: "/" });
  context.cookies.delete(accessSessionCookie, { path: "/" });
  return context.redirect("/settings/");
};
