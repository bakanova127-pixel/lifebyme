// Life By Me — бот + API для мини-приложения (Yandex Cloud Function, Node.js)
// Данные участников хранятся в YDB (Россия). Данные о здоровье (цикл, вес, самочувствие) сюда не попадают — они остаются на телефоне.
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
const FREE_UNTIL = () => env("FREE_UNTIL") || "2026-12-01"; // до этой даты (не включая) клуб бесплатный для всех
const TG_BASE = () => (env("TG_API") || "https://api.telegram.org").replace(/\/+$/, ""); // адрес Telegram API или посредника (Cloudflare Worker)
const DAY = 864e5;
const PROD_URL = () => (env("PRODAMUS_URL") || "").replace(/\/+$/, "");
const PROD_KEY = () => env("PRODAMUS_KEY");
const LOCAL_ONLY = /^(cycle|weight|care)(__|$)/; // данные о здоровье — никогда не храним на сервере

let DB = null;
const db = () => DB || (DB = env("YDB_ENDPOINT") ? ydbDb() : memoryDb());
const setDb = d => { DB = d; };

// ---------- helpers ----------
let tgFetch = (url, opts) => fetch(url, opts);
const setTgFetch = f => { tgFetch = f; };
async function tg(method, body) {
  let j = {};
  try {
    const r = await tgFetch(`${TG_BASE()}/bot${TOKEN()}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    j = await r.json();
  } catch (e) { j = { ok: false, description: String(e && e.message || e) }; }
  if (!j.ok) console.log("tg error", method, JSON.stringify(j).slice(0, 300));
  return j;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mskDay = (ms = Date.now()) => new Date(ms + 3 * 3600e3).toISOString().slice(0, 10);
const mskMin = (ms = Date.now()) => { const d = new Date(ms + 3 * 3600e3); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const hm = s => { const [h, m] = String(s || "0:0").split(":").map(Number); return h * 60 + (m || 0); };
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const ru = d => { const [y, m, dd] = d.split("-"); return `${+dd} ${MONTHS[+m - 1]} ${y}`; };
const ruShort = d => { const [, m, dd] = d.split("-"); return `${+dd} ${MONTHS[+m - 1]}`; };
const addDays = (d, n) => mskDay(Date.parse(d + "T12:00:00Z") + n * DAY - 3 * 3600e3);
const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const freeEnd = () => Date.parse(FREE_UNTIL() + "T00:00:00+03:00");
const isFree = () => Date.now() < freeEnd();
const freeLabel = () => isFree() ? `До ${ruShort(FREE_UNTIL())}` : "";
const flags = u => new Set((u.rem || "").split(",").filter(Boolean));
const setFlags = (u, s) => { u.rem = [...s].slice(-30).join(","); };

function trialEnd(u) { const t = +u.trial || 0; if (!t) return 0; return Math.max(t, freeEnd()) + TRIAL_DAYS() * DAY; }
function access(u) {
  if (!u) return { ok: false, kind: "none" };
  if (+u.id === ADMIN()) return { ok: true, kind: "admin" };
  const today = mskDay();
  if (u.paid && u.paid >= today) return { ok: true, kind: "paid", until: u.paid };
  if (isFree()) return { ok: true, kind: "free", until: FREE_UNTIL() };
  const end = trialEnd(u);
  if (end && Date.now() < end) return { ok: true, kind: "trial", ends: end, daysLeft: Math.ceil((end - Date.now()) / DAY) };
  return { ok: false, kind: u.trial ? "expired" : "new", paidWas: u.paid || "" };
}

// Пока нет согласия — храним только id (без имени и ника).
async function touch(from) {
  const id = +from.id; let u = await db().getUser(id); const now = String(Date.now());
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  if (!u) u = { id, name: "", username: "", created: now, trial: "", paid: "", seen: now, rem: "", consent: "" };
  else u = { ...u, seen: now };
  if (u.consent) { u.name = name || u.name; u.username = from.username || u.username; }
  await db().putUser(u);
  return u;
}
async function agree(u, from) {
  u.consent = String(Date.now());
  u.name = [from.first_name, from.last_name].filter(Boolean).join(" ") || u.name;
  u.username = from.username || u.username || "";
  await db().putUser(u);
  console.log("consent", u.id, u.consent);
  return u;
}

// ---------- Продамус ----------
// Подпись как в официальной библиотеке Продамуса (Hmac::create): все значения → строки, ключи сортируются рекурсивно, JSON без экранирования юникода, HMAC-SHA256.
function prodSort(v) {
  if (Array.isArray(v)) return v.map(prodSort);
  if (v && typeof v === "object") { const o = {}; Object.keys(v).sort(phpKeyCmp).forEach(k => o[k] = prodSort(v[k])); return o; }
  return v == null ? "" : String(v);
}
function phpKeyCmp(a, b) { const na = /^-?\d+$/.test(a), nb = /^-?\d+$/.test(b); if (na && nb) return +a - +b; return a < b ? -1 : a > b ? 1 : 0; }
function isList(o) { const ks = Object.keys(o); return ks.length > 0 && ks.every((k, i) => k === String(i)); }
function phpJson(v, slashes) {
  if (Array.isArray(v)) return "[" + v.map(x => phpJson(x, slashes)).join(",") + "]";
  if (v && typeof v === "object") { if (isList(v)) return "[" + Object.keys(v).map(k => phpJson(v[k], slashes)).join(",") + "]"; return "{" + Object.keys(v).map(k => JSON.stringify(k) + ":" + phpJson(v[k], slashes)).join(",") + "}"; }
  let s = JSON.stringify(String(v)); if (slashes) s = s.replace(/\//g, "\\/"); return s;
}
function prodSign(data, slashes = true) { return crypto.createHmac("sha256", PROD_KEY()).update(phpJson(prodSort(data), slashes)).digest("hex"); }
function parseForm(raw) { // products[0][name]=… → вложенный объект, как $_POST в PHP
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    const parts = k.replace(/\]/g, "").split("["); let o = out;
    parts.forEach((p, i) => { if (i === parts.length - 1) o[p] = v; else o = o[p] = o[p] && typeof o[p] === "object" ? o[p] : {}; });
  }
  return out;
}
function payLink(u, plan) {
  if (!PROD_URL()) return null;
  const data = { do: "pay", order_id: `lbm-${u.id}-${plan.id}-${Date.now()}`, customer_extra: `Life By Me — ${plan.t}`, products: [{ name: `Life By Me — ${plan.t}`, price: String(plan.price), quantity: "1" }] };
  if (env("BOT_USERNAME")) { data.urlSuccess = `https://t.me/${env("BOT_USERNAME")}`; data.urlReturn = `https://t.me/${env("BOT_USERNAME")}`; }
  if (PROD_KEY()) data.signature = prodSign(data);
  const q = new URLSearchParams();
  const add = (pre, v) => { if (v && typeof v === "object") Object.entries(v).forEach(([k, x]) => add(`${pre}[${k}]`, x)); else q.append(pre, v); };
  Object.entries(data).forEach(([k, v]) => add(k, v));
  return `${PROD_URL()}/?${q.toString()}`;
}
async function onProdamus(raw, headers, ctype) {
  let data = {}; try { data = /json/.test(ctype || "") || /^\s*\{/.test(raw) ? JSON.parse(raw) : parseForm(raw); } catch (e) { data = parseForm(raw); }
  const sign = (headers["sign"] || "").toLowerCase();
  const ok = !!PROD_KEY() && !!sign && (prodSign(data, true) === sign || prodSign(data, false) === sign);
  const orderNum = String(data.order_num || data.order_id || ""); const m = orderNum.match(/^lbm-(\d+)-(\w+)-(\d+)$/);
  const plan = m && T.PLANS.find(p => p.id === m[2]); const sum = parseFloat(String(data.sum || "0").replace(",", "."));
  const success = String(data.payment_status || "").toLowerCase() === "success";
  console.log("prodamus", JSON.stringify({ orderNum, status: data.payment_status, sum, ok }));
  if (!success) return [200, "success"];
  if (!ok || !m || !plan || sum + 0.01 < plan.price) {
    if (ADMIN()) await tg("sendMessage", { chat_id: ADMIN(), text: `⚠️ Пришло уведомление об оплате, но я не смогла его подтвердить (${!ok ? "подпись не совпала" : !plan ? "неизвестный заказ" : "сумма меньше тарифа"}).\nЗаказ: ${orderNum}\nСумма: ${data.sum}\nПроверь в кабинете Продамуса и при необходимости выдай доступ: /give ${m ? m[1] : "ID"} ${plan ? plan.days : 30}` });
    return [ok ? 200 : 400, ok ? "success" : "bad sign"];
  }
  const u = await db().getUser(+m[1]); if (!u) return [200, "success"];
  const rem = flags(u); const tag = "o" + m[3];
  if (rem.has(tag)) return [200, "success"]; // уже засчитано
  const base = u.paid && u.paid >= mskDay() ? u.paid : mskDay();
  u.paid = addDays(base, plan.days); rem.add(tag); setFlags(u, [...rem].filter(x => !x.startsWith("p")));
  await db().putUser(u);
  await tg("sendMessage", { chat_id: u.id, parse_mode: "HTML", text: T.paid(plan.t, ru(u.paid)), reply_markup: { inline_keyboard: [[btnApp()]] } });
  if (ADMIN()) await tg("sendMessage", { chat_id: ADMIN(), parse_mode: "HTML", text: `💰 <b>Оплата!</b> ${esc(u.name)}${u.username ? " @" + esc(u.username) : ""}\nТариф: ${plan.t} — ${data.sum} ₽\nДоступ до ${ru(u.paid)}` });
  return [200, "success"];
}

// ---------- keyboards ----------
const btnApp = (t = "✨ Открыть приложение") => ({ text: t, web_app: { url: APP_URL() } });
const kbConsent = () => ({ inline_keyboard: [[{ text: T.consentBtn, callback_data: "agree" }]] });
const kbMain = () => ({ inline_keyboard: [[btnApp()], [{ text: "🖤 Что внутри клуба", callback_data: "inside" }], isFree() ? [{ text: "❓ Вопросы", callback_data: "faq" }] : [{ text: "💳 Тарифы", callback_data: "plans" }, { text: "❓ Вопросы", callback_data: "faq" }]] });
// кнопки админа (внизу экрана вместо команд)
const AB = { stats: "📊 Статистика", users: "👥 Участники", club: "🏆 Таблица челленджа", winner: "🎁 Выбрать победителя", votes: "🗳 Голосование", bc: "📣 Рассылка", posts: "🗓 Анонсы" };
const kbAdmin = () => ({ keyboard: [[{ text: AB.stats }, { text: AB.users }], [{ text: AB.club }, { text: AB.winner }], [{ text: AB.votes }, { text: AB.posts }], [{ text: AB.bc }]], resize_keyboard: true, is_persistent: true });
const kbBack = () => ({ inline_keyboard: [[btnApp()], [{ text: "⬅️ Назад", callback_data: "back" }]] });
const kbPlans = () => ({ inline_keyboard: [...(isFree() ? [] : [[{ text: "💳 Оплатить", callback_data: "pay" }]]), [btnApp()], [{ text: "⬅️ Назад", callback_data: "back" }]] });
const kbPayLinks = u => { const rows = T.PLANS.map(p => { const url = payLink(u, p); return url ? [{ text: `${p.e} ${p.t} — ${p.price.toLocaleString("ru-RU")} ₽`, url }] : null; }).filter(Boolean); return rows.length ? { inline_keyboard: rows } : null; };
async function sendPay(chat, u) {
  if (isFree() && !(u && +u.id === ADMIN())) return tg("sendMessage", { chat_id: chat, text: T.payFree(freeLabel().toLowerCase()), reply_markup: { inline_keyboard: [[btnApp()]] } });
  const kb = kbPayLinks(u); if (kb) return tg("sendMessage", { chat_id: chat, text: T.payChoose, reply_markup: kb });
  return tg("sendMessage", { chat_id: chat, text: T.payManual(ADMIN_NICK()) });
}
const kbPay = () => ({ inline_keyboard: [[{ text: "💳 Тарифы и оплата", callback_data: "plans" }], [btnApp("Открыть приложение")]] });
const kbCh = () => ({ inline_keyboard: [[btnApp("☀️ Открыть и отметиться")], [{ text: "🔕 Не напоминать про челлендж", callback_data: "choff" }]] });

// ---------- bot ----------
async function sendConsent(chat) { return tg("sendMessage", { chat_id: chat, text: T.consent, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kbConsent() }); }
async function sendWelcome(chat) {
  const r = await tg("sendPhoto", { chat_id: chat, photo: PHOTO(), caption: T.welcome(freeLabel()), parse_mode: "HTML", reply_markup: kbMain() });
  if (!r.ok) await tg("sendMessage", { chat_id: chat, text: T.welcome(freeLabel()), parse_mode: "HTML", reply_markup: kbMain() });
}
const accLabel = a => a.kind === "paid" ? "оплачено до " + ru(a.until) : a.kind === "free" ? "бесплатный месяц" : a.kind === "trial" ? "пробный" : a.kind === "expired" ? "пробный закончился" : a.kind === "admin" ? "админ" : "не открывал(а) приложение";
async function adminCmd(text, chat, u) {
  const map = { [AB.stats]: "/stats", [AB.users]: "/users", [AB.club]: "/club", [AB.winner]: "/winner", [AB.votes]: "/votes", [AB.posts]: "/posts", [AB.bc]: "/bc" };
  if (map[text.trim()]) text = map[text.trim()];
  const [cmd, ...rest] = text.trim().split(/\s+/);
  if (cmd === "/bc") { const f = flags(u); f.add("bc"); setFlags(u, f); await db().putUser(u); return tg("sendMessage", { chat_id: chat, text: T.bcAsk, reply_markup: { inline_keyboard: [[{ text: "Отмена", callback_data: "bcno" }]] } }); }
  if (cmd === "/votes") {
    const cfg = await clubFull(); const vp = (cfg.posts || []).filter(p => p.vote).sort((a, b) => a.date < b.date ? 1 : -1)[0];
    if (!vp) return tg("sendMessage", { chat_id: chat, text: "Голосований пока нет." });
    const ms = await db().clubMembers("vote|" + vp.id); const cnt = vp.vote.map((o, i) => [o, ms.filter(m => m.name === String(i)).length]).sort((a, b) => b[1] - a[1]);
    return tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: `🗳 <b>Голосование</b> (${ru(vp.date)})\nПроголосовали: ${ms.length}\n\n` + cnt.map(([o, n]) => `${n} — ${esc(o)}`).join("\n") });
  }
  if (cmd === "/posts") {
    const cfg = await clubFull(); const today = mskDay();
    const ps = (cfg.posts || []).filter(p => p.date >= addDays(today, -1)).sort((a, b) => (a.date + a.time) < (b.date + b.time) ? -1 : 1);
    if (!ps.length) return tg("sendMessage", { chat_id: chat, text: "Запланированных анонсов нет." });
    for (const p of ps.slice(0, 6)) { await tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: `🗓 <b>${ru(p.date)}, ${p.time || "12:00"}</b>${p.vote ? " · с голосованием" : ""}\n\n${p.text}`.replace("{winner}", "«имя победителя»") }); }
    return tg("sendMessage", { chat_id: chat, text: "Это анонсы, которые уйдут всем участникам. Поменять текст — напиши мне в Claude." });
  }
  if (cmd === "/stats") {
    const us = await db().listUsers(); const now = Date.now(), today = mskDay();
    const ok = us.filter(u => u.consent);
    const paid = ok.filter(u => u.paid && u.paid >= today).length;
    const newToday = ok.filter(u => mskDay(+u.created) === today).length;
    const active7 = ok.filter(u => now - +u.seen < 7 * DAY).length;
    const opened = ok.filter(u => u.trial).length;
    return tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: `📊 <b>Клуб сегодня</b>\n\nВсего с согласием: ${ok.length}\nОткрывали приложение: ${opened}\nНовых сегодня: ${newToday}\nАктивны за 7 дней: ${active7}\nОплачено: ${paid}${isFree() ? `\n\n🎁 Бесплатный период до ${ruShort(FREE_UNTIL())}` : ""}` });
  }
  if (cmd === "/users") {
    const us = (await db().listUsers()).filter(u => u.consent).sort((a, b) => +b.created - +a.created).slice(0, 15);
    const line = u => `• ${esc(u.name)}${u.username ? " @" + esc(u.username) : ""} — <code>${u.id}</code> — ${accLabel(access(u))}`;
    return tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: "👥 <b>Последние 15</b>\n\n" + (us.map(line).join("\n") || "пока никого") });
  }
  if (cmd === "/give") {
    const who = rest[0] || "", days = parseInt(rest[1] || "30", 10);
    if (!who || !days) return tg("sendMessage", { chat_id: chat, text: "Напиши так: /give 123456789 30  или  /give @nick 90" });
    let u = null;
    if (/^\d+$/.test(who)) u = await db().getUser(+who);
    else { const nick = who.replace(/^@/, "").toLowerCase(); u = (await db().listUsers()).find(x => (x.username || "").toLowerCase() === nick); }
    if (!u) return tg("sendMessage", { chat_id: chat, text: "Не нашла. Пусть сначала нажмёт «Начать» в боте и согласится с условиями." });
    const base = u.paid && u.paid >= mskDay() ? u.paid : mskDay();
    u.paid = addDays(base, days); setFlags(u, [...flags(u)].filter(x => !x.startsWith("p")));
    await db().putUser(u);
    await tg("sendMessage", { chat_id: u.id, parse_mode: "HTML", text: T.granted(ru(u.paid)), reply_markup: { inline_keyboard: [[btnApp()]] } });
    return tg("sendMessage", { chat_id: chat, text: `✅ ${u.name}: доступ до ${ru(u.paid)}` });
  }
  if (cmd === "/reply") {
    const id = +rest[0], msg = rest.slice(1).join(" ");
    if (!id || !msg) return tg("sendMessage", { chat_id: chat, text: "Напиши так: /reply 123456789 текст ответа" });
    const r = await tg("sendMessage", { chat_id: id, text: "💌 " + msg });
    return tg("sendMessage", { chat_id: chat, text: r.ok ? "Отправила ✅" : "Не получилось отправить (возможно, бот заблокирован)" });
  }
  if (cmd === "/broadcast") {
    const msg = text.trim().slice("/broadcast".length).trim();
    if (!msg) return tg("sendMessage", { chat_id: chat, text: "Напиши так: /broadcast текст для всех" });
    const n = await broadcast(msg, { inline_keyboard: [[btnApp()]] });
    return tg("sendMessage", { chat_id: chat, text: `Разослала: ${n.ok} из ${n.all} ✅` });
  }
  if (cmd === "/club") {
    const c = await activeChallenge(true);
    if (!c) return tg("sendMessage", { chat_id: chat, text: "Сейчас нет челленджа клуба." });
    const st = await db().clubStats(c.id, mskDay());
    const top = st.board.slice(0, 30).map((b, i) => `${i + 1}. ${esc(b.name)} — ${b.n} из ${c.len}`).join("\n");
    return tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: `🏆 <b>${esc(c.title)}</b>\nВ челлендже: ${st.members}\nСегодня отметились: ${st.today}\n\n${top || "пока нет отметок"}` });
  }
  if (cmd === "/winner") {
    const c = await activeChallenge(true);
    if (!c) return tg("sendMessage", { chat_id: chat, text: "Не нашла челлендж клуба." });
    const st = await db().clubStats(c.id, mskDay());
    const fin = st.board.filter(b => b.n >= c.len);
    if (!fin.length) return tg("sendMessage", { chat_id: chat, text: `Пока никто не прошёл все ${c.len} дней. Лучший результат: ${st.board[0] ? st.board[0].n : 0}.` });
    const w = fin[crypto.randomInt(fin.length)]; const wu = await db().getUser(w.uid);
    await db().kvPut(0, { ["winner_" + c.id]: JSON.stringify({ uid: w.uid, name: w.name, at: Date.now() }) });
    return tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: `🎁 Дошли до конца: ${fin.length}\n\n<b>Победитель:</b> ${esc(w.name)}${wu && wu.username ? " @" + esc(wu.username) : ""}\nid: <code>${w.uid}</code>\n\nЕго имя появится в анонсе итогов. Написать победителю — ответь на это сообщение.`, reply_markup: { inline_keyboard: [[{ text: "🔄 Выбрать заново", callback_data: "reroll" }]] } });
  }
  if (cmd === "/admin") {
    return tg("sendMessage", { chat_id: chat, reply_markup: kbAdmin(), text: "Команды админа (всё то же есть кнопками внизу):\n/stats — цифры клуба\n/users — последние 15 участников\n/club — таблица челленджа\n/winner — случайный победитель среди прошедших все дни\n/give @nick 30 — открыть доступ на 30 дней\n/reply ID текст — ответить участнику\n/broadcast текст — рассылка всем\n\nМожно и проще: ответь (свайп влево) на пересланное сообщение — ответ уйдёт человеку." });
  }
  return null;
}
async function onMessage(m) {
  const chat = m.chat.id; if (m.chat.type !== "private") return;
  const text = (m.text || "").trim();
  if (text === "/myid") return tg("sendMessage", { chat_id: chat, text: `Твой id: ${m.from.id}` });
  const u = await touch(m.from); const isAdmin = +m.from.id === ADMIN();
  if (!u.consent) { if (text.startsWith("/start")) return sendConsent(chat); return tg("sendMessage", { chat_id: chat, text: T.consentNeed, reply_markup: kbConsent() }); }
  if (text.startsWith("/start")) { if (/pay/.test(text)) return sendPay(chat, u); await sendWelcome(chat); if (isAdmin) await tg("sendMessage", { chat_id: chat, text: T.adminHi, reply_markup: kbAdmin() }); if (/plans/.test(text)) await tg("sendMessage", { chat_id: chat, text: T.plans(freeLabel()), parse_mode: "HTML", reply_markup: kbPlans() }); return; }
  if (text === "/app") return tg("sendMessage", { chat_id: chat, text: T.openApp, reply_markup: { inline_keyboard: [[btnApp()]] } });
  if (text === "/plans") return tg("sendMessage", { chat_id: chat, text: T.plans(freeLabel()), parse_mode: "HTML", reply_markup: kbPlans() });
  if (text === "/help") return tg("sendMessage", { chat_id: chat, text: T.faq(ADMIN_NICK()), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kbBack() });
  if (text === "/delete") return tg("sendMessage", { chat_id: chat, text: T.delAsk, reply_markup: { inline_keyboard: [[{ text: "🗑 Да, удалить всё", callback_data: "delyes" }], [{ text: "Нет, оставить", callback_data: "delno" }]] } });
  if (text === "/remind") { const f = flags(u); f.delete("nocr"); setFlags(u, f); await db().putUser(u); return tg("sendMessage", { chat_id: chat, text: T.chOn }); }
  if (isAdmin) {
    if (flags(u).has("bc") && text && !text.startsWith("/") && !Object.values(AB).includes(text)) {
      const f = flags(u); f.delete("bc"); setFlags(u, f); await db().putUser(u);
      await db().kvPut(0, { bc_draft: text });
      return tg("sendMessage", { chat_id: chat, text: "Так увидят все участники 👇\n\n" + text, reply_markup: { inline_keyboard: [[{ text: "✅ Отправить всем", callback_data: "bcyes" }], [{ text: "Отмена", callback_data: "bcno" }]] } });
    }
    if (text.startsWith("/") || Object.values(AB).includes(text)) { const r = await adminCmd(text, chat, u); if (r !== null) return r; }
    const rt = m.reply_to_message && (m.reply_to_message.text || "");
    const mm = rt && rt.match(/\bid: (\d+)/);
    if (mm && text) { const r = await tg("sendMessage", { chat_id: +mm[1], text: "💌 " + text }); return tg("sendMessage", { chat_id: chat, text: r.ok ? "Отправила ✅" : "Не получилось отправить" }); }
    return;
  }
  if (text && !text.startsWith("/") && ADMIN()) {
    await tg("sendMessage", { chat_id: ADMIN(), parse_mode: "HTML", text: `💬 <b>${esc(u.name)}</b>${u.username ? " @" + esc(u.username) : ""}\nid: ${u.id}\n\n${esc(text)}\n\n<i>Ответь на это сообщение — ответ уйдёт человеку</i>` });
    return tg("sendMessage", { chat_id: chat, text: T.supportSent });
  }
}
async function onCallback(cq) {
  const d = cq.data, m = cq.message; await tg("answerCallbackQuery", { callback_query_id: cq.id });
  if (!m) return; let u = await touch(cq.from); const chat = m.chat.id;
  if (d.startsWith("v|")) { // голосование
    const [, pid, i] = d.split("|"); const cfg = await clubFull(); const vp = (cfg.posts || []).find(p => p.id === pid && p.vote);
    if (!vp || !vp.vote[+i]) return; if (!u.consent) return sendConsent(chat);
    await db().clubJoin("vote|" + pid, u.id, String(+i));
    return tg("sendMessage", { chat_id: chat, text: T.voteThanks(vp.vote[+i]) });
  }
  if (+cq.from.id === ADMIN()) {
    if (d === "reroll") return adminCmd("/winner", chat, u);
    if (d === "bcno") { const f = flags(u); f.delete("bc"); setFlags(u, f); await db().putUser(u); return tg("sendMessage", { chat_id: chat, text: "Рассылка отменена." }); }
    if (d === "bcyes") {
      const msg = (await db().kvAll(0)).bc_draft; if (!msg) return tg("sendMessage", { chat_id: chat, text: "Черновик не найден, нажми «📣 Рассылка» ещё раз." });
      await db().kvPut(0, {}, ["bc_draft"]); await tg("editMessageReplyMarkup", { chat_id: chat, message_id: m.message_id, reply_markup: { inline_keyboard: [] } });
      const n = await broadcast(msg, { inline_keyboard: [[btnApp()]] });
      return tg("sendMessage", { chat_id: chat, text: `Разослала: ${n.ok} из ${n.all} ✅` });
    }
  }
  if (d === "agree") {
    if (!u.consent) u = await agree(u, cq.from);
    await tg("editMessageReplyMarkup", { chat_id: chat, message_id: m.message_id, reply_markup: { inline_keyboard: [] } });
    return sendWelcome(chat);
  }
  if (!u.consent) return sendConsent(chat);
  if (d === "delyes") { await db().deleteUser(u.id); await tg("editMessageReplyMarkup", { chat_id: chat, message_id: m.message_id, reply_markup: { inline_keyboard: [] } }); return tg("sendMessage", { chat_id: chat, text: T.delDone }); }
  if (d === "delno") return tg("editMessageText", { chat_id: chat, message_id: m.message_id, text: "Хорошо, ничего не удаляю 🖤" });
  if (d === "choff") { const f = flags(u); f.add("nocr"); setFlags(u, f); await db().putUser(u); return tg("sendMessage", { chat_id: chat, text: T.chOff }); }
  const pages = { inside: [T.inside, kbBack()], plans: [T.plans(freeLabel()), kbPlans()], faq: [T.faq(ADMIN_NICK()), kbBack()], back: [T.welcome(freeLabel()), kbMain()] };
  if (d === "pay") return sendPay(chat, u);
  const p = pages[d]; if (!p) return;
  const base = { chat_id: chat, message_id: m.message_id, parse_mode: "HTML", reply_markup: p[1] };
  const r = m.photo ? await tg("editMessageCaption", { ...base, caption: p[0] }) : await tg("editMessageText", { ...base, text: p[0], disable_web_page_preview: true });
  if (!r.ok) await tg("sendMessage", { chat_id: chat, text: p[0], parse_mode: "HTML", disable_web_page_preview: true, reply_markup: p[1] });
}

// ---------- mini app API ----------
function checkInitData(initData, maxAgeSec = 30 * 86400) {
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
  if (action === "agree") { if (!u.consent) u = await agree(u, user); return [200, { ok: true, consent: true }]; }
  if (action === "me") {
    if (u.consent && !u.trial && +u.id !== ADMIN()) { u.trial = String(Date.now()); await db().putUser(u); }
    return [200, { ...access(u), consent: !!u.consent, docs: T.DOCS, freeUntil: isFree() ? FREE_UNTIL() : "", trialDays: TRIAL_DAYS(), admin: +u.id === ADMIN(), bot: env("BOT_USERNAME"), plans: T.PLANS.map(p => ({ id: p.id, t: p.t, e: p.e, price: p.price, note: p.note || "", url: isFree() ? null : payLink(u, p) })) }];
  }
  if (!u.consent) return [403, { error: "consent" }];
  if (action === "kv") {
    if (body.op === "all") return [200, { kv: await db().kvAll(u.id) }];
    if (body.op === "put") {
      const put = {}, del = []; let total = 0;
      for (const [k, v] of Object.entries(body.put || {}).slice(0, 300)) {
        if (!/^[\w.-]{1,80}$/.test(k) || LOCAL_ONLY.test(k) || typeof v !== "string") continue;
        if (v.length > 64000) return [413, { error: "big", k }];
        total += v.length; put[k] = v;
      }
      if (total > 900000) return [413, { error: "big" }];
      for (const k of (body.del || []).slice(0, 300)) if (typeof k === "string" && /^[\w.-]{1,80}$/.test(k)) del.push(k);
      await db().kvPut(u.id, put, del);
      return [200, { ok: true }];
    }
    return [400, { error: "op" }];
  }
  if (action === "rem") {
    const now = Date.now();
    const list = (Array.isArray(body.list) ? body.list : []).filter(r => r && /^[\w.-]{1,60}$/.test(r.id || "") && +r.at > now - 60e3 && +r.at < now + 40 * DAY && typeof r.text === "string").slice(0, 200)
      .map(r => ({ id: r.id, at: Math.round(+r.at), text: r.text.slice(0, 300) }));
    await db().remSet(u.id, list);
    return [200, { ok: true, n: list.length }];
  }
  if (action === "club") {
    const ch = String(body.ch || "").slice(0, 60); if (!ch) return [400, { error: "ch" }];
    const day = /^\d{4}-\d{2}-\d{2}$/.test(body.day || "") ? body.day : mskDay();
    const nm = (user.first_name || "").slice(0, 30);
    if (body.op === "join") await db().clubJoin(ch, u.id, nm);
    if (body.op === "mark") {
      const c = (await clubConfig()).find(x => x.id === ch);
      const v = body.v === 1 || body.v === 0 ? body.v : null;
      if (c && c.win && v !== null) { // отметка только в окне времени и только за сегодня
        const t = mskMin();
        if (day !== mskDay() || t < hm(c.win[0]) || t >= hm(c.win[1])) return [409, { error: "window", win: c.win }];
      }
      await db().clubJoin(ch, u.id, nm); await db().clubMark(ch, day, u.id, v);
    }
    const st = await db().clubStats(ch, body.op === "stats" ? day : mskDay());
    st.board = st.board.map(b => ({ name: b.name, n: b.n, me: b.uid === u.id }));
    return [200, st];
  }
  if (action === "delete") { await db().deleteUser(u.id); return [200, { ok: true }]; }
  return [404, { error: "unknown" }];
}

async function broadcast(text, kb, opts) {
  const us = (await db().listUsers()).filter(u => u.consent); let ok = 0;
  for (const u of us) { const r = await tg("sendMessage", Object.assign({ chat_id: u.id, text, reply_markup: kb }, opts || {})); if (r.ok) ok++; await sleep(40); }
  return { ok, all: us.length };
}

// ---------- челлендж клуба и анонсы (club.json из приложения) ----------
let CLUB = null, CLUBF = null, CLUB_AT = 0;
async function clubFull() {
  if (CLUBF && Date.now() - CLUB_AT < 10 * 60e3) return CLUBF;
  try { const r = await fetch(APP_URL().replace(/\/?$/, "/") + "club.json?t=" + Date.now()); const j = await r.json(); CLUBF = j || {}; CLUB = (j.challenges || []).filter(c => c && c.id && c.start && c.len); CLUB_AT = Date.now(); }
  catch (e) { console.log("club.json", e && e.message); CLUBF = CLUBF || { challenges: CLUB || [] }; CLUB = CLUB || []; }
  return CLUBF;
}
async function clubConfig() { await clubFull(); return CLUB || []; }
// Анонсы по расписанию: club.json → posts: [{id, date, time, text, vote?: [варианты], app?: true}]
async function scheduledPosts() {
  const cfg = await clubFull(); const today = mskDay(), t = mskMin(); let sent = 0;
  for (const p of cfg.posts || []) {
    if (!p || !p.id || p.date !== today || t < hm(p.time || "12:00") || t > hm(p.time || "12:00") + 120) continue;
    let text = String(p.text || "");
    if (text.includes("{winner}")) {
      const ch = p.ch || ((cfg.challenges || [])[0] || {}).id; const w = (await db().kvAll(0))["winner_" + ch];
      if (!w) { if (await db().once(`postwait|${p.id}|${today}|${Math.floor(t / 30)}`) && ADMIN()) await tg("sendMessage", { chat_id: ADMIN(), text: "⏳ Анонс итогов ждёт победителя — нажми «🎁 Выбрать победителя», и я сразу разошлю.", reply_markup: kbAdmin() }); continue; }
      text = text.replace(/\{winner\}/g, JSON.parse(w).name);
    }
    if (/\{[a-z]+\}/.test(text)) { if (await db().once(`postbad|${p.id}`) && ADMIN()) await tg("sendMessage", { chat_id: ADMIN(), text: `⚠️ Анонс на ${ru(p.date)} не отправлен: в тексте не заполнено ${text.match(/\{[a-z]+\}/)[0]}. Напиши мне в Claude, что вставить.` }); continue; }
    if (!(await db().once("post|" + p.id))) continue;
    const kb = p.vote ? { inline_keyboard: p.vote.map((o, i) => [{ text: o, callback_data: `v|${p.id}|${i}` }]) } : { inline_keyboard: [[btnApp()]] };
    const n = await broadcast(text, kb, { parse_mode: "HTML" }); sent += n.ok;
    if (ADMIN()) await tg("sendMessage", { chat_id: ADMIN(), text: `📣 Анонс «${text.slice(0, 40)}…» отправлен: ${n.ok} из ${n.all}` });
  }
  return sent;
}
async function activeChallenge(orLast) {
  const today = mskDay(); const cl = await clubConfig();
  const act = cl.find(c => c.start <= today && today <= addDays(c.start, c.len - 1));
  if (act || !orLast) return act || null;
  return cl.filter(c => c.start <= today).sort((a, b) => a.start < b.start ? 1 : -1)[0] || null;
}
async function challengeReminders() {
  const c = await activeChallenge(false); if (!c || !c.win) return 0;
  const today = mskDay(), t = mskMin(), from = hm(c.win[0]), to = hm(c.win[1]); let sent = 0;
  const n = Math.round((Date.parse(today) - Date.parse(c.start)) / DAY) + 1;
  let kind = null;
  if (t >= from && t < from + 30) kind = "m"; else if (t >= to - 30 && t < to - 5) kind = "l";
  if (!kind || !(await db().once(`ch|${c.id}|${today}|${kind}`))) return 0;
  const members = await db().clubMembers(c.id);
  const done = new Set((await db().clubDayMarks(c.id, today)).filter(x => +x.v === 1).map(x => +x.uid));
  for (const mb of members) {
    if (done.has(+mb.uid)) continue;
    const u = await db().getUser(mb.uid); if (!u || !u.consent || flags(u).has("nocr")) continue;
    const text = kind === "m" ? T.chMorning(c.title, n, c.len, c.win[0], c.win[1]) : T.chLate(c.title, c.win[1]);
    const r = await tg("sendMessage", { chat_id: u.id, text, reply_markup: kbCh() }); if (r.ok) sent++;
    await sleep(40);
  }
  return sent;
}

// ---------- напоминания (таймер раз в 5 минут) ----------
async function taskReminders() {
  const now = Date.now(); const due = await db().remDue(now); let sent = 0;
  for (const r of due) {
    if (r.at > now - 20 * 60e3) { const x = await tg("sendMessage", { chat_id: r.uid, text: r.text, reply_markup: { inline_keyboard: [[btnApp("Открыть дела")]] } }); if (x.ok) sent++; await sleep(40); }
  }
  if (due.length) await db().remDel(due);
  return sent;
}
async function accessReminders() {
  const today = mskDay(), now = Date.now();
  if (isFree() || mskMin() < 10 * 60 || mskMin() > 21 * 60) return 0; // пишем про оплату только днём
  const us = await db().listUsers(); let sent = 0;
  for (const u of us) {
    if (+u.id === ADMIN() || !u.consent) continue;
    const rem = flags(u); let msg = null, flag = null;
    const paidActive = u.paid && u.paid >= today; const end = trialEnd(u);
    if (!paidActive && end) {
      const createdInFree = +u.trial < freeEnd();
      if (createdInFree && now >= freeEnd() && now < freeEnd() + DAY && !rem.has("f1")) { msg = T.freeOver; flag = "f1"; }
      else if (now >= end - DAY && now < end && !rem.has("t1")) { msg = T.trialSoon; flag = "t1"; }
      else if (now >= end && now < end + 7 * DAY && !rem.has("t2") && !u.paid) { msg = T.trialOver; flag = "t2"; }
    }
    if (paidActive && u.paid <= addDays(today, 2) && !rem.has("p" + u.paid)) { msg = T.paidSoon(ru(u.paid)); flag = "p" + u.paid; }
    if (msg) { const r = await tg("sendMessage", { chat_id: u.id, text: msg, reply_markup: kbPay() }); rem.add(flag); setFlags(u, rem); await db().putUser(u); if (r.ok) sent++; await sleep(40); }
  }
  return sent;
}
async function reminders() {
  const out = {};
  for (const [k, f] of [["tasks", taskReminders], ["challenge", challengeReminders], ["posts", scheduledPosts], ["access", accessReminders]]) {
    try { out[k] = await f(); } catch (e) { console.log("reminders", k, e && e.stack || e); out[k] = "error"; }
  }
  return out;
}

// ---------- setup ----------
async function setup(selfUrl, fid) {
  const out = {};
  const hook = env("TG_API") && fid ? `${TG_BASE()}/hook/${fid}` : selfUrl + "?a=tg";
  out.hook = hook;
  out.webhook = await tg("setWebhook", { url: hook, secret_token: env("WEBHOOK_SECRET"), allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
  out.commands = await tg("setMyCommands", { commands: [{ command: "start", description: "Начать" }, { command: "app", description: "Открыть приложение" }, ...(isFree() ? [] : [{ command: "plans", description: "Тарифы клуба" }]), { command: "help", description: "Вопросы и поддержка" }, { command: "delete", description: "Удалить мои данные" }] });
  out.menu = await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Открыть клуб", web_app: { url: APP_URL() } } });
  if (ADMIN()) out.adminCmds = await tg("setMyCommands", { scope: { type: "chat", chat_id: ADMIN() }, commands: [{ command: "start", description: "Начать и показать кнопки админа" }, { command: "admin", description: "Все команды" }] });
  return out;
}

// ---------- entry ----------
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const reply = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS }, body: JSON.stringify(obj) });
module.exports.handler = async function (event, context) {
  try {
    if (event && Array.isArray(event.messages) && event.messages[0] && !event.httpMethod) { const n = await reminders(); return { statusCode: 200, body: "reminders " + JSON.stringify(n) }; }
    const method = event.httpMethod || "GET";
    if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
    const qs = event.queryStringParameters || {}; const h = {}; Object.entries(event.headers || {}).forEach(([k, v]) => h[k.toLowerCase()] = v);
    let raw = event.body || ""; if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf8");
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch (e) {}
    const a = qs.a || "";
    if (a === "tg" || (!a && method === "POST" && body && body.update_id)) {
      if (env("WEBHOOK_SECRET") && h["x-telegram-bot-api-secret-token"] !== env("WEBHOOK_SECRET")) return { statusCode: 403, body: "no" };
      if (body.message) await onMessage(body.message); else if (body.callback_query) await onCallback(body.callback_query);
      return { statusCode: 200, body: "ok" };
    }
    if (["me", "agree", "club", "kv", "rem", "delete"].includes(a)) { const [c, o] = await api(a, body); return reply(c, o); }
    if (a === "prodamus") { const [c, t] = await onProdamus(raw, h, h["content-type"]); return { statusCode: c, headers: { "Content-Type": "text/plain" }, body: t }; }
    if (a === "setup") {
      if (!env("WEBHOOK_SECRET") || qs.s !== env("WEBHOOK_SECRET")) return reply(403, { error: "нужен правильный секрет: ?a=setup&s=..." });
      const fid = (env("FUNCTION_URL").match(/functions\.yandexcloud\.net\/([a-z0-9]+)/) || [])[1] || (context && (context.functionName || context.functionId)) || "";
      const self = env("FUNCTION_URL") || `https://functions.yandexcloud.net/${fid}`;
      let tgOk = true; try { const me = await tg("getMe", {}); tgOk = !!me.ok; } catch (e) { tgOk = false; }
      const out = await setup(self, fid);
      return reply(200, { url: self, telegram: tgOk ? "доступен ✅" : "недоступен ❌ — проверь TG_API (посредник)", ...out });
    }
    if (a === "remind" && qs.s && qs.s === env("WEBHOOK_SECRET")) return reply(200, { sent: await reminders() });
    if (a === "diag" && qs.s && qs.s === env("WEBHOOK_SECRET")) { // проверка без токена: что видит Telegram и как отвечает база
      const wh = await tg("getWebhookInfo", {}); const w = wh.result || {};
      const t0 = Date.now(); let dbr; try { dbr = await db().health(); } catch (e) { dbr = "ошибка: " + (e && e.message); }
      return reply(200, { webhook_url: w.url || "", pending: w.pending_update_count, last_error: w.last_error_message || "нет", last_error_date: w.last_error_date ? new Date(w.last_error_date * 1000).toISOString() : "", db: dbr, db_ms: Date.now() - t0, admin: ADMIN() || "не задан", secret_set: !!env("WEBHOOK_SECRET"), relay: env("TG_API") || "нет" });
    }
    if (a === "health") return reply(200, { ok: true, db: await db().health(), token: !!TOKEN(), admin: ADMIN() || null, relay: !!env("TG_API"), freeUntil: FREE_UNTIL() });
    return reply(200, { ok: true, service: "Life By Me" });
  } catch (e) {
    console.log("ERROR", e && e.stack || e);
    return reply(500, { error: String(e && e.message || e) });
  }
};
module.exports._test = { setClubFull: j => { CLUBF = j; CLUB = (j.challenges || []); CLUB_AT = Date.now(); }, checkInitData, access, setDb, setTgFetch, reminders, mskDay, addDays, prodSign, parseForm, payLink, phpJson, prodSort, setClub: c => { CLUB = c; CLUB_AT = Date.now(); } };
