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

  try {
    const r = await fetch(target, init);
    const out = new Headers();
    const ct = r.headers.get("content-type");
    if (ct) out.set("content-type", ct);
    return new Response(r.body, { status: r.status, headers: out });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, description: "relay: " + String(e && e.message || e) }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }
}
