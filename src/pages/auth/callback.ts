import type { APIRoute } from "astro";

export const GET: APIRoute = async context => context.redirect("/settings/");

