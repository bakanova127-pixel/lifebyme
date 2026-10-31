// Посредник между Telegram и облачной функцией.
// Нужен потому, что api.telegram.org недоступен из Yandex Cloud напрямую.
//
// Что умеет:
//   /                     -> "relay ok" (проверка живости)
//   /bot<токен>/<метод>   -> api.telegram.org — исходящие вызовы функции
//   /file/bot<токен>/...  -> api.telegram.org — скачивание голосовых
//   /hook/<id функции>    -> облачная функция — входящие сообщения от Telegram

export const config = { runtime: "edge" };

const TG = "https://api.telegram.org";
const YC = "https://functions.yandexcloud.net";

export default async function handler(req) {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/" || path === "") return new Response("relay ok");

  let target;
  if (path.startsWith("/hook/")) {
    const fid = path.slice(6).split("/")[0];
    if (!/^[a-z0-9]+$/.test(fid)) return new Response("bad hook", { status: 400 });
    target = `${YC}/${fid}?a=tg`;
  } else if (path.startsWith("/bot") || path.startsWith("/file/bot")) {
    target = TG + path + url.search;
  } else {
    return new Response("not found", { status: 404 });
  }

  const headers = new Headers();
  for (const name of ["content-type", "x-telegram-bot-api-secret-token"]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }

  const init = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") init.body = await req.arrayBuffer();

  // Never let a stalled upstream exhaust Vercel's 25-second execution limit.
  // Do not log the path: /bot<token>/... contains the bot credential.
  const route = path.startsWith("/hook/") ? "webhook" : "telegram-api";
  const timeoutMs = route === "webhook" ? 9000 : 6000;
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let r;
    try {
      r = await fetch(target, { ...init, signal: controller.signal });
      // Read before clearing timeout, so stalled response bodies are also bounded.
      const body = await r.arrayBuffer();
      const out = new Headers();
      const ct = r.headers.get("content-type");
      if (ct) out.set("content-type", ct);
      if (!r.ok || Date.now() - started > 1500) console.log(JSON.stringify({ route, status: r.status, ms: Date.now() - started }));
      return new Response(body, { status: r.status, headers: out });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    const timedOut = e && e.name === "AbortError";
    console.error(JSON.stringify({ route, error: timedOut ? "upstream_timeout" : "upstream_network_error", ms: Date.now() - started }));
    return new Response(JSON.stringify({ ok: false, description: timedOut ? "relay upstream timeout" : "relay upstream unavailable" }), {
      status: timedOut ? 504 : 502, headers: { "content-type": "application/json" },
    });
  }
}
