import type { APIRoute } from "astro";

export const POST: APIRoute = async () =>
  new Response(JSON.stringify({ error: "邮箱登录已关闭，请使用激活码" }), {
    status: 410,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

