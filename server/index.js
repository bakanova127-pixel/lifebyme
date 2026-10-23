// Life by me Club — бот + API для мини-приложения (Yandex Cloud Function, Node.js)
const crypto = require("crypto");
const T = require("./texts");
const { memoryDb, ydbDb } = require("./db");

const env = k => process.env[k] || "";
const TOKEN = () => env("BOT_TOKEN");
const ADMIN = () => +env("ADMIN_ID") || 0;
const ADMIN_NICK = () => env("ADMIN_USERNAME") || "Яне";
const APP_URL = () => env("APP_URL") || "https://bakanova127-pixel.github.io/lifebyme/";
const PHOTO = () => env("WELCOME_PHOTO") || "https://bakanova127-pixel.github.io/lifebyme/welcome.jpg";
const TRIAL_DAYS = () => +env("TRIAL_DAYS") || 3;
const DAY = 864e5;

let DB = null;
const db = () => DB || (DB = env("YDB_ENDPOINT") ? ydbDb() : memoryDb());
const setDb = d => { DB = d; };

// ---------- helpers ----------
let tgFetch = (url, opts) => fetch(url, opts);
const setTgFetch = f => { tgFetch = f; };
async function tg(method, body) {
  const r = await tgFetch(`https://api.telegram.org/bot${TOKEN()}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (!j.ok) console.log("tg error", method, JSON.stringify(j).slice(0, 300));
  return j;
}
const mskDay = (ms = Date.now()) => new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const ru = d => { const [y, m, dd] = d.split("-"); return `${+dd} ${MONTHS[+m - 1]} ${y}`; };
const addDays = (d, n) => mskDay(Date.parse(d + "T12:00:00Z") + n * DAY - 3 * 3600e3);
const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function access(u) {
  if (!u) return { ok: false, kind: "none" };
  if (+u.id === ADMIN()) return { ok: true, kind: "admin" };
  const today = mskDay();
  if (u.paid && u.paid >= today) return { ok: true, kind: "paid", until: u.paid };
  const t = +u.trial || 0;
  if (t && Date.now() < t + TRIAL_DAYS() * DAY) return { ok: true, kind: "trial", ends: t + TRIAL_DAYS() * DAY, daysLeft: Math.ceil((t + TRIAL_DAYS() * DAY - Date.now()) / DAY) };
  return { ok: false, kind: t ? "expired" : "new", paidWas: u.paid || "" };
}

async function touch(from) {
  const id = +from.id; let u = await db().getUser(id); const now = String(Date.now());
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  if (!u) u = { id, name, username: from.username || "", created: now, trial: "", paid: "", seen: now, rem: "" };
  else u = { ...u, name: name || u.name, username: from.username || u.username, seen: now };
  await db().putUser(u);
  return u;
}

// ---------- keyboards ----------
const btnApp = (t = "✨ Открыть приложение") => ({ text: t, web_app: { url: APP_URL() } });
const kbMain = () => ({ inline_keyboard: [[btnApp()], [{ text: "🌸 Что внутри клуба", callback_data: "inside" }], [{ text: "💳 Тарифы", callback_data: "plans" }, { text: "❓ Вопросы", callback_data: "faq" }]] });
const kbBack = () => ({ inline_keyboard: [[btnApp("✨ Попробовать бесплатно")], [{ text: "⬅️ Назад", callback_data: "back" }]] });
const kbPlans = () => ({ inline_keyboard: [[{ text: "💳 Оплатить", callback_data: "pay" }], [btnApp("✨ Попробовать бесплатно")], [{ text: "⬅️ Назад", callback_data: "back" }]] });
const kbPay = () => ({ inline_keyboard: [[{ text: "💳 Тарифы и оплата", callback_data: "plans" }], [btnApp("Открыть приложение")]] });

// ---------- bot ----------
async function sendWelcome(chat) {
  const r = await tg("sendPhoto", { chat_id: chat, photo: PHOTO(), caption: T.welcome, parse_mode: "HTML", reply_markup: kbMain() });
  if (!r.ok) await tg("sendMessage", { chat_id: chat, text: T.welcome, parse_mode: "HTML", reply_markup: kbMain() });
}
async function adminCmd(text, chat) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  if (cmd === "/stats") {
    const us = await db().listUsers(); const now = Date.now(), today = mskDay();
    const trial = us.filter(u => +u.trial && now < +u.trial + TRIAL_DAYS() * DAY && !(u.paid >= today)).length;
    const paid = us.filter(u => u.paid && u.paid >= today).length;
    const newToday = us.filter(u => mskDay(+u.created) === today).length;
    const active7 = us.filter(u => now - +u.seen < 7 * DAY).length;
    return tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: `📊 <b>Клуб сегодня</b>\n\nВсего в боте: ${us.length}\nНовых сегодня: ${newToday}\nВ пробном периоде: ${trial}\nОплачено: ${paid}\nАктивны за 7 дней: ${active7}` });
  }
  if (cmd === "/users") {
    const us = (await db().listUsers()).sort((a, b) => +b.created - +a.created).slice(0, 15);
    const line = u => { const a = access(u); return `• ${esc(u.name)}${u.username ? " @" + esc(u.username) : ""} — <code>${u.id}</code> — ${a.kind === "paid" ? "оплачено до " + ru(a.until) : a.kind === "trial" ? "пробный" : a.kind === "expired" ? "пробный закончился" : a.kind === "admin" ? "админ" : "не открывала приложение"}`; };
    return tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: "👭 <b>Последние 15</b>\n\n" + (us.map(line).join("\n") || "пока никого") });
  }
  if (cmd === "/give") {
    const who = rest[0] || "", days = parseInt(rest[1] || "30", 10);
    if (!who || !days) return tg("sendMessage", { chat_id: chat, text: "Напиши так: /give 123456789 30  или  /give @nick 90" });
    let u = null;
    if (/^\d+$/.test(who)) u = await db().getUser(+who);
    else { const nick = who.replace(/^@/, "").toLowerCase(); u = (await db().listUsers()).find(x => (x.username || "").toLowerCase() === nick); }
    if (!u) return tg("sendMessage", { chat_id: chat, text: "Не нашла её. Пусть сначала нажмёт «Начать» в боте." });
    const base = u.paid && u.paid >= mskDay() ? u.paid : mskDay();
    u.paid = addDays(base, days); u.rem = (u.rem || "").split(",").filter(x => !x.startsWith("p")).join(",");
    await db().putUser(u);
    await tg("sendMessage", { chat_id: u.id, parse_mode: "HTML", text: T.granted(ru(u.paid)), reply_markup: { inline_keyboard: [[btnApp()]] } });
    return tg("sendMessage", { chat_id: chat, text: `✅ ${u.name}: доступ до ${ru(u.paid)}` });
  }
  if (cmd === "/reply") {
    const id = +rest[0], msg = rest.slice(1).join(" ");
    if (!id || !msg) return tg("sendMessage", { chat_id: chat, text: "Напиши так: /reply 123456789 текст ответа" });
    const r = await tg("sendMessage", { chat_id: id, text: "💌 " + msg });
    return tg("sendMessage", { chat_id: chat, text: r.ok ? "Отправила ✅" : "Не получилось отправить (возможно, она заблокировала бота)" });
  }
  if (cmd === "/broadcast") {
    const msg = text.trim().slice("/broadcast".length).trim();
    if (!msg) return tg("sendMessage", { chat_id: chat, text: "Напиши так: /broadcast текст для всех" });
    const us = await db().listUsers(); let ok = 0;
    for (const u of us) { const r = await tg("sendMessage", { chat_id: u.id, text: msg, reply_markup: { inline_keyboard: [[btnApp()]] } }); if (r.ok) ok++; await new Promise(r => setTimeout(r, 40)); }
    return tg("sendMessage", { chat_id: chat, text: `Разослала: ${ok} из ${us.length} ✅` });
  }
  if (cmd === "/admin") {
    return tg("sendMessage", { chat_id: chat, text: "Команды админа:\n/stats — цифры клуба\n/users — последние 15 участниц\n/give @nick 30 — открыть доступ на 30 дней\n/reply ID текст — ответить девочке\n/broadcast текст — рассылка всем\n\nМожно и проще: ответь (свайп влево) на пересланное сообщение девочки — ответ уйдёт ей." });
  }
  return null;
}
async function onMessage(m) {
  const chat = m.chat.id; if (m.chat.type !== "private") return;
  const u = await touch(m.from); const text = (m.text || "").trim(); const isAdmin = +m.from.id === ADMIN();
  if (text.startsWith("/start")) { await sendWelcome(chat); if (/pay|plans/.test(text)) await tg("sendMessage", { chat_id: chat, text: T.plans, parse_mode: "HTML", reply_markup: kbPlans() }); return; }
  if (text === "/app") return tg("sendMessage", { chat_id: chat, text: T.openApp, reply_markup: { inline_keyboard: [[btnApp()]] } });
  if (text === "/plans") return tg("sendMessage", { chat_id: chat, text: T.plans, parse_mode: "HTML", reply_markup: kbPlans() });
  if (text === "/help") return tg("sendMessage", { chat_id: chat, text: T.faq(ADMIN_NICK()), parse_mode: "HTML", reply_markup: kbBack() });
  if (isAdmin) {
    if (text.startsWith("/")) { const r = await adminCmd(text, chat); if (r !== null) return r; }
    const rt = m.reply_to_message && (m.reply_to_message.text || "");
    const mm = rt && rt.match(/\bid: (\d+)/);
    if (mm && text) { const r = await tg("sendMessage", { chat_id: +mm[1], text: "💌 " + text }); return tg("sendMessage", { chat_id: chat, text: r.ok ? "Отправила ✅" : "Не получилось отправить" }); }
    return;
  }
  if (text && !text.startsWith("/") && ADMIN()) {
    await tg("sendMessage", { chat_id: ADMIN(), parse_mode: "HTML", text: `💬 <b>${esc(u.name)}</b>${u.username ? " @" + esc(u.username) : ""}\nid: ${u.id}\n\n${esc(text)}\n\n<i>Ответь на это сообщение — ответ уйдёт ей</i>` });
    return tg("sendMessage", { chat_id: chat, text: T.supportSent });
  }
}
async function onCallback(cq) {
  const d = cq.data, m = cq.message; await tg("answerCallbackQuery", { callback_query_id: cq.id });
  if (!m) return; await touch(cq.from);
  const pages = { inside: [T.inside, kbBack()], plans: [T.plans, kbPlans()], faq: [T.faq(ADMIN_NICK()), kbBack()], back: [T.welcome, kbMain()] };
  if (d === "pay") return tg("sendMessage", { chat_id: m.chat.id, text: T.payManual(ADMIN_NICK()) });
  const p = pages[d]; if (!p) return;
  const base = { chat_id: m.chat.id, message_id: m.message_id, parse_mode: "HTML", reply_markup: p[1] };
  const r = m.photo ? await tg("editMessageCaption", { ...base, caption: p[0] }) : await tg("editMessageText", { ...base, text: p[0] });
  if (!r.ok) await tg("sendMessage", { chat_id: m.chat.id, text: p[0], parse_mode: "HTML", reply_markup: p[1] });
}

// ---------- mini app API ----------
function checkInitData(initData, maxAgeSec = 7 * 86400) {
  if (!initData || !TOKEN()) return null;
  const p = new URLSearchParams(initData); const hash = p.get("hash"); if (!hash) return null; p.delete("hash");
  const dcs = [...p.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(TOKEN()).digest();
  const h = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
  if (h.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash))) return null;
  if (maxAgeSec && Date.now() / 1000 - +p.get("auth_date") > maxAgeSec) return null;
  try { return JSON.parse(p.get("user")); } catch (e) { return null; }
}
async function api(action, body) {
  const user = checkInitData(body.initData); if (!user) return [401, { error: "auth" }];
  let u = await touch(user);
  if (action === "me") {
    if (!u.trial && +u.id !== ADMIN()) { u.trial = String(Date.now()); await db().putUser(u); }
    return [200, { ...access(u), trialDays: TRIAL_DAYS(), admin: +u.id === ADMIN(), bot: env("BOT_USERNAME") }];
  }
  if (action === "club") {
    const ch = String(body.ch || "").slice(0, 60); if (!ch) return [400, { error: "ch" }];
    const day = /^\d{4}-\d{2}-\d{2}$/.test(body.day || "") ? body.day : mskDay();
    if (body.op === "join") await db().clubJoin(ch, u.id, (user.first_name || "").slice(0, 30));
    if (body.op === "mark") { await db().clubJoin(ch, u.id, (user.first_name || "").slice(0, 30)); await db().clubMark(ch, day, u.id, body.v === 1 || body.v === 0 ? body.v : null); }
    return [200, await db().clubStats(ch, body.op === "stats" ? day : mskDay())];
  }
  return [404, { error: "unknown" }];
}

// ---------- reminders (timer) ----------
async function reminders() {
  const us = await db().listUsers(); const now = Date.now(), today = mskDay(); let sent = 0;
  for (const u of us) {
    if (+u.id === ADMIN()) continue;
    const rem = new Set((u.rem || "").split(",").filter(Boolean)); let msg = null, kb = kbPay(), flag = null;
    const paidActive = u.paid && u.paid >= today;
    const end = +u.trial ? +u.trial + TRIAL_DAYS() * DAY : 0;
    if (!paidActive && end) {
      if (now >= end - DAY && now < end && !rem.has("t1")) { msg = T.trialSoon; flag = "t1"; }
      else if (now >= end && now < end + 7 * DAY && !rem.has("t2") && !u.paid) { msg = T.trialOver; flag = "t2"; }
    }
    if (paidActive && u.paid <= addDays(today, 2) && !rem.has("p" + u.paid)) { msg = T.paidSoon(ru(u.paid)); flag = "p" + u.paid; }
    if (msg) { await tg("sendMessage", { chat_id: u.id, text: msg, reply_markup: kb }); rem.add(flag); u.rem = [...rem].join(","); await db().putUser(u); sent++; }
  }
  return sent;
}

// ---------- setup ----------
async function setup(selfUrl) {
  const out = {};
  out.webhook = await tg("setWebhook", { url: selfUrl + "?a=tg", secret_token: env("WEBHOOK_SECRET"), allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
  out.commands = await tg("setMyCommands", { commands: [{ command: "start", description: "Начать" }, { command: "app", description: "Открыть приложение" }, { command: "plans", description: "Тарифы клуба" }, { command: "help", description: "Вопросы и поддержка" }] });
  out.menu = await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Открыть клуб 🌸", web_app: { url: APP_URL() } } });
  if (ADMIN()) out.adminCmds = await tg("setMyCommands", { scope: { type: "chat", chat_id: ADMIN() }, commands: [{ command: "stats", description: "Цифры клуба" }, { command: "users", description: "Последние участницы" }, { command: "give", description: "Открыть доступ: /give @nick 30" }, { command: "broadcast", description: "Рассылка всем" }, { command: "admin", description: "Все команды" }, { command: "start", description: "Начать" }] });
  return out;
}

// ---------- entry ----------
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const reply = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS }, body: JSON.stringify(obj) });
module.exports.handler = async function (event, context) {
  try {
    if (event && Array.isArray(event.messages) && event.messages[0] && /Timer/i.test(JSON.stringify(event.messages[0].event_metadata || {}))) { const n = await reminders(); return { statusCode: 200, body: "reminders " + n }; }
    const method = event.httpMethod || "GET";
    if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
    const qs = event.queryStringParameters || {}; const h = {}; Object.entries(event.headers || {}).forEach(([k, v]) => h[k.toLowerCase()] = v);
    let raw = event.body || ""; if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch (e) {}
    const a = qs.a || "";
    if (a === "tg") {
      if (env("WEBHOOK_SECRET") && h["x-telegram-bot-api-secret-token"] !== env("WEBHOOK_SECRET")) return { statusCode: 403, body: "no" };
      if (body.message) await onMessage(body.message); else if (body.callback_query) await onCallback(body.callback_query);
      return { statusCode: 200, body: "ok" };
    }
    if (a === "me" || a === "club") { const [c, o] = await api(a, body); return reply(c, o); }
    if (a === "setup") {
      if (!env("WEBHOOK_SECRET") || qs.s !== env("WEBHOOK_SECRET")) return reply(403, { error: "нужен правильный секрет: ?a=setup&s=..." });
      const self = env("FUNCTION_URL") || `https://functions.yandexcloud.net/${context && context.functionName}`;
      return reply(200, { url: self, ...(await setup(self)) });
    }
    if (a === "remind" && qs.s && qs.s === env("WEBHOOK_SECRET")) return reply(200, { sent: await reminders() });
    if (a === "health") return reply(200, { ok: true, db: await db().health(), token: !!TOKEN(), admin: ADMIN() || null });
    return reply(200, { ok: true, service: "Life by me Club" });
  } catch (e) {
    console.log("ERROR", e && e.stack || e);
    return reply(500, { error: String(e && e.message || e) });
  }
};
module.exports._test = { checkInitData, access, setDb, setTgFetch, reminders, mskDay, addDays };
