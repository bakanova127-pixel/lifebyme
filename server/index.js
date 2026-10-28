// Life By Me — бот + API для мини-приложения (Yandex Cloud Function, Node.js)
// Данные участников хранятся в YDB (Россия). Данные о здоровье (цикл, вес, самочувствие) сюда не попадают — они остаются на телефоне.
const crypto = require("crypto");
const T = require("./texts");
const { memoryDb, ydbDb, s3Db, setS3Token } = require("./db");
const { parseAll } = require("./dict");

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
const TESTERS = () => env("TESTERS").split(/[\s,;]+/).filter(Boolean).map(Number); // тестовый режим: пока список не пуст, клуб открыт только этим id и админу
const isTester = id => !TESTERS().length || +id === ADMIN() || TESTERS().includes(+id);
const CLUB_CHAT = () => env("CLUB_CHAT_ID"); // закрытый канал клуба: бот — админ канала, вход по заявке, бот одобряет только тех, у кого есть доступ
const LOCAL_ONLY = /^(cycle|weight|care)(__|$)/; // данные о здоровье — никогда не храним на сервере

let DB = null;
const db = () => DB || (DB = env("USE_YDB") ? ydbDb() : s3Db(env("BUCKET") || "lifebyme-data")); // по умолчанию — бакет lifebyme-data в Object Storage
const setDb = d => { DB = d; };

// ---------- helpers ----------
let tgFetch = (url, opts) => fetch(url, opts);
// обезличенный id участника для ленты (настоящий Telegram id другим не показываем)
const pid = uid => crypto.createHmac("sha256", env("WEBHOOK_SECRET") || TOKEN() || "lbm").update(String(+uid)).digest("hex").slice(0, 12);
async function tgPhoto(chat, buf, caption) {
  try {
    const fd = new FormData(); fd.append("chat_id", String(chat)); if (caption) fd.append("caption", caption);
    fd.append("photo", new Blob([buf], { type: "image/jpeg" }), "life-by-me.jpg");
    const r = await tgFetch(`${TG_BASE()}/bot${TOKEN()}/sendPhoto`, { method: "POST", body: fd }); const j = await r.json(); if (!j.ok) console.log("tg photo", JSON.stringify(j).slice(0, 300)); return j;
  } catch (e) { console.log("tg photo", e && e.message); return { ok: false }; }
}
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
// Клуб бесплатный навсегда. Чтобы вернуть подписку и оплату через Продамус, задай переменную PAID_MODE=1.
const PAID = () => env("PAID_MODE") === "1";
const isFree = () => !PAID() || Date.now() < freeEnd();
const freeLabel = () => !PAID() ? "Всегда" : isFree() ? `До ${ruShort(FREE_UNTIL())}` : "";
const flags = u => new Set((u.rem || "").split(",").filter(Boolean));
const setFlags = (u, s) => { u.rem = [...s].slice(-30).join(","); };

// цена основателя: кто вступил до конца бесплатного ноября — тарифы 390 ₽ навсегда
const isFounder = u => !!u && ((+u.consent && +u.consent < freeEnd()) || !!u.founder);
const plansFor = u => isFounder(u) ? T.PLANS : T.PLANS_NEW;
function trialEnd(u) { const t = +u.trial || 0; if (!t) return 0; return Math.max(t, freeEnd()) + TRIAL_DAYS() * DAY; }
function access(u) {
  if (!u) return { ok: false, kind: "none" };
  if (+u.id === ADMIN()) return { ok: true, kind: "admin" };
  const today = mskDay();
  const gift = u.gift && u.gift >= today ? u.gift : "";
  if (u.paid && u.paid >= today) return { ok: true, kind: "paid", until: [u.paid, gift].sort().pop(), paidUntil: u.paid, gift };
  if (isFree()) return { ok: true, kind: "free", until: PAID() ? FREE_UNTIL() : "", gift };
  if (gift) return { ok: true, kind: "gift", until: gift, gift };
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
  const plan = m && T.PLANS.concat(T.PLANS_NEW).find(p => p.id === m[2]); const sum = parseFloat(String(data.sum || "0").replace(",", "."));
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
  const base = [u.paid || "", u.gift || "", mskDay()].sort().pop();
  u.paid = addDays(base, plan.days); rem.add(tag); setFlags(u, [...rem].filter(x => !x.startsWith("p")));
  await db().putUser(u);
  await tg("sendMessage", { chat_id: u.id, parse_mode: "HTML", text: T.paid(plan.t, ru(u.paid)), reply_markup: { inline_keyboard: [[btnApp()]] } });
  if (CLUB_CHAT() && !(await isMember(u))) await sendClubInvite(u.id);
  await refCredit(u); // друг оплатил — пригласившему неделя
  if (ADMIN()) await tg("sendMessage", { chat_id: ADMIN(), parse_mode: "HTML", text: `💰 <b>Оплата!</b> ${esc(u.name)}${u.username ? " @" + esc(u.username) : ""}\nТариф: ${plan.t} — ${data.sum} ₽\nДоступ до ${ru(u.paid)}` });
  return [200, "success"];
}

// ---------- keyboards ----------
const btnApp = (t = "✨ Открыть приложение") => ({ text: t, web_app: { url: APP_URL() } });
const kbConsent = () => ({ inline_keyboard: [[{ text: T.consentBtn, callback_data: "agree" }]] });
const kbMain = () => ({ inline_keyboard: [[btnApp()], [{ text: "🖤 Что внутри клуба", callback_data: "inside" }], [{ text: "🎁 Пригласить друга", callback_data: "invite" }], isFree() ? [{ text: "❓ Вопросы", callback_data: "faq" }] : [{ text: "💳 Тарифы", callback_data: "plans" }, { text: "❓ Вопросы", callback_data: "faq" }]] });
// кнопки админа (внизу экрана вместо команд)
const AB = { stats: "📊 Статистика", users: "👥 Участники", club: "🏆 Таблица челленджа", winner: "🎁 Выбрать победителя", votes: "🗳 Голосование", bc: "📣 Рассылка", posts: "🗓 Анонсы", fb: "💬 Отзывы" };
const kbAdmin = () => ({ keyboard: [[{ text: AB.stats }, { text: AB.users }], [{ text: AB.club }, { text: AB.winner }], [{ text: AB.votes }, { text: AB.posts }], [{ text: AB.bc }, { text: AB.fb }]], resize_keyboard: true, is_persistent: true });
const kbBack = () => ({ inline_keyboard: [[btnApp()], [{ text: "⬅️ Назад", callback_data: "back" }]] });
const kbPlans = () => ({ inline_keyboard: [...(isFree() ? [] : [[{ text: "💳 Оплатить", callback_data: "pay" }]]), [btnApp()], [{ text: "⬅️ Назад", callback_data: "back" }]] });
const kbPayLinks = u => { const rows = plansFor(u).map(p => { const url = payLink(u, p); return url ? [{ text: `${p.e} ${p.t} — ${p.price.toLocaleString("ru-RU")} ₽`, url }] : null; }).filter(Boolean); return rows.length ? { inline_keyboard: rows } : null; };
async function sendPay(chat, u) {
  if (isFree() && !(u && +u.id === ADMIN())) return tg("sendMessage", { chat_id: chat, text: T.payFree(freeLabel().toLowerCase()), reply_markup: { inline_keyboard: [[btnApp()]] } });
  const kb = kbPayLinks(u); if (kb) return tg("sendMessage", { chat_id: chat, text: T.payChoose, reply_markup: kb });
  return tg("sendMessage", { chat_id: chat, text: T.payManual(ADMIN_NICK()) });
}
const kbPay = () => ({ inline_keyboard: [[{ text: "💳 Тарифы и оплата", callback_data: "plans" }], [btnApp("Открыть приложение")]] });
const kbCh = () => ({ inline_keyboard: [[btnApp("☀️ Открыть и отметиться")], [{ text: "🔕 Не напоминать про челлендж", callback_data: "choff" }]] });

// ---------- закрытый канал клуба ----------
async function clubLink() {
  if (!CLUB_CHAT()) return "";
  const sys = await db().kvAll(0); if (sys.club_link && sys.club_chat === CLUB_CHAT()) return sys.club_link;
  const r = await tg("createChatInviteLink", { chat_id: CLUB_CHAT(), name: "Life By Me — вход по заявке", creates_join_request: true });
  if (!r.ok) return ""; await db().kvPut(0, { club_link: r.result.invite_link, club_chat: CLUB_CHAT() }); return r.result.invite_link;
}
async function isMember(u) {
  if (!CLUB_CHAT() || +u.id === ADMIN()) return true;
  if (u.mem && Date.now() - +u.mem < 6 * 3600e3) return true;
  const r = await tg("getChatMember", { chat_id: CLUB_CHAT(), user_id: u.id });
  const st = r.ok && r.result && r.result.status; const ok = st === "creator" || st === "administrator" || st === "member" || (st === "restricted" && r.result.is_member);
  if (ok) { u.mem = String(Date.now()); await db().putUser(u); }
  return ok;
}
async function sendClubInvite(chat) {
  const link = await clubLink(); if (!link) return;
  return tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: T.clubInvite, reply_markup: { inline_keyboard: [[{ text: "🖤 Вступить в закрытый клуб", url: link }]] } });
}
async function onJoin(j) {
  if (String(j.chat.id) !== String(CLUB_CHAT())) return;
  const uid = +j.from.id; const u = await db().getUser(uid); const a = access(u);
  if (u && u.consent && a.ok && isTester(uid)) {
    await tg("approveChatJoinRequest", { chat_id: j.chat.id, user_id: uid }); u.mem = String(Date.now()); const f = flags(u); f.delete("kick"); setFlags(u, f); await db().putUser(u);
    await refOnJoin(u);
    return tg("sendMessage", { chat_id: uid, text: T.clubIn, reply_markup: { inline_keyboard: [[btnApp()]] } });
  }
  await tg("declineChatJoinRequest", { chat_id: j.chat.id, user_id: uid });
  const bot = env("BOT_USERNAME");
  return tg("sendMessage", { chat_id: uid, text: !u || !u.consent ? T.clubNeedStart : T.clubNeedPay, reply_markup: { inline_keyboard: [[bot ? { text: "Открыть бота", url: `https://t.me/${bot}?start=club` } : btnApp()]] } });
}
async function kickExpired(u) {
  if (!CLUB_CHAT() || +u.id === ADMIN()) return;
  const f = flags(u); if (f.has("kick")) return;
  await tg("banChatMember", { chat_id: CLUB_CHAT(), user_id: u.id, until_date: Math.floor(Date.now() / 1000) + 60 });
  await tg("unbanChatMember", { chat_id: CLUB_CHAT(), user_id: u.id, only_if_banned: true });
  f.add("kick"); setFlags(u, f); u.mem = ""; await db().putUser(u);
}

// ---------- bot ----------
async function chLine() { const cs = await clubConfig(); const t = mskDay(); const c = cs.find(x => x.start <= t && addDays(x.start, x.len - 1) >= t) || cs.filter(x => x.start > t).sort((a, b) => a.start < b.start ? -1 : 1)[0]; if (!c) return ""; return c.start > t ? `Старт ${ru(c.start)} — «${c.name || c.title}».` : `Сейчас идёт «${c.name || c.title}» — вступить можно в любой день.`; }
async function sendConsent(chat) { // первое сообщение: картинка, коротко о клубе и одна кнопка «Вступить» (она же согласие)
  const caption = T.start(await chLine(), isFree());
  const r = await tg("sendPhoto", { chat_id: chat, photo: PHOTO(), caption, parse_mode: "HTML", reply_markup: kbConsent() });
  if (!r.ok) return tg("sendMessage", { chat_id: chat, text: caption, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kbConsent() });
  return r;
}
async function sendInClub(chat, u, fresh) { // второе сообщение: канал + приложение (или тарифы, если доступа нет)
  const a = access(u); if (!a.ok) return tg("sendMessage", { chat_id: chat, text: T.plans(freeLabel(), isFounder(u)), parse_mode: "HTML", reply_markup: kbPlans() });
  const rows = []; let channel = false;
  if (CLUB_CHAT() && !(await isMember(u))) { const link = await clubLink(); if (link) { rows.push([{ text: "🖤 Войти в канал клуба", url: link }]); channel = true; } }
  rows.push([btnApp("✨ Открыть приложение")]);
  rows.push([{ text: "🎁 Пригласить друга", callback_data: "invite" }, isFree() ? { text: "❓ Вопросы", callback_data: "faq" } : { text: "💳 Тарифы", callback_data: "plans" }]);
  return tg("sendMessage", { chat_id: chat, text: channel || fresh ? T.inClub(channel) : T.inClubDone, reply_markup: { inline_keyboard: rows } });
}
async function sendWelcome(chat) {
  const r = await tg("sendPhoto", { chat_id: chat, photo: PHOTO(), caption: T.welcome(freeLabel()), parse_mode: "HTML", reply_markup: kbMain() });
  if (!r.ok) await tg("sendMessage", { chat_id: chat, text: T.welcome(freeLabel()), parse_mode: "HTML", reply_markup: kbMain() });
}
const accLabel = a => a.kind === "paid" ? "оплачено до " + ru(a.until) : a.kind === "gift" ? "неделя за друзей до " + ru(a.until) : a.kind === "free" ? "бесплатный месяц" : a.kind === "trial" ? "пробный" : a.kind === "expired" ? "пробный закончился" : a.kind === "admin" ? "админ" : "не открывал(а) приложение";
// ---------- анонсы: управление прямо в боте ----------
async function postsSave(list) { await db().kvPut(0, { posts: JSON.stringify(list) }); const cfg = await clubFull(); cfg.posts = list; }
const postHead = p => `🗓 <b>${ru(p.date)}, ${p.time || "12:00"}</b>${p.vote ? " · с голосованием" : ""}${p.report ? " · с итогами челленджа" : ""}`;
const postBody = p => p.report && !p.text ? "<i>Здесь будут цифры челленджа и топ участников — бот посчитает сам.</i>" : String(p.text || "").replace("{winner}", "«имя победителя»");
const kbPost = p => ({ inline_keyboard: [[...(p.report ? [] : [{ text: "✏️ Текст", callback_data: "pe|" + p.id }]), { text: "📅 Дата", callback_data: "pd|" + p.id }, { text: "🗑 Удалить", callback_data: "px|" + p.id }]] });
async function admState(v) { if (v === undefined) { try { return JSON.parse((await db().kvAll(0)).adm_state || "null"); } catch (e) { return null; } } if (v === null) return db().kvPut(0, {}, ["adm_state"]); return db().kvPut(0, { adm_state: JSON.stringify(v) }); }
function parsePostDate(t) {
  const low = t.toLowerCase().replace(/ё/g, "е"); let d = null, m;
  if ((m = low.match(/(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?(?!\d)/)) && !/:/.test(low.slice(m.index + m[0].length, m.index + m[0].length + 1))) d = [+m[1], +m[2], m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null];
  else if ((m = low.match(/(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/))) d = [+m[1], MONTHS.indexOf(m[2]) + 1, null];
  if (!d || d[1] < 1 || d[1] > 12 || d[0] < 1 || d[0] > 31) return null;
  const tm = (low.replace(m[0], "").match(/(\d{1,2})[:.](\d{2})/) || []); const time = tm[0] ? `${String(+tm[1]).padStart(2, "0")}:${tm[2]}` : "12:00";
  const y = d[2] || +mskDay().slice(0, 4); let iso = `${y}-${String(d[1]).padStart(2, "0")}-${String(d[0]).padStart(2, "0")}`; if (!d[2] && iso < mskDay()) iso = `${y + 1}${iso.slice(4)}`;
  return { date: iso, time };
}
async function adminText(text, chat) { // ответ админа на вопрос «пришли новый текст / дату»
  const st = await admState(); if (!st) return null;
  const cfg = await clubFull(); const list = (cfg.posts || []).slice();
  if (st.mode === "edit") { const p = list.find(x => x.id === st.id); if (!p) { await admState(null); return tg("sendMessage", { chat_id: chat, text: "Не нашла этот анонс." }); }
    p.text = esc(text); await postsSave(list); await admState(null); return tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: "✅ Текст обновлён:\n\n" + postHead(p) + "\n\n" + postBody(p), reply_markup: kbPost(p) }); }
  if (st.mode === "new") { await admState({ mode: "newdate", text: esc(text) }); return tg("sendMessage", { chat_id: chat, text: "Когда отправить? Напиши дату и время, например: 28.11 19:00", reply_markup: { inline_keyboard: [[{ text: "Отмена", callback_data: "pcancel" }]] } }); }
  if (st.mode === "date" || st.mode === "newdate") {
    const dt = parsePostDate(text); if (!dt) return tg("sendMessage", { chat_id: chat, text: "Не поняла дату. Напиши так: 28.11 19:00 или 28 ноября 19:00" });
    let p; if (st.mode === "date") { p = list.find(x => x.id === st.id); if (!p) { await admState(null); return tg("sendMessage", { chat_id: chat, text: "Не нашла этот анонс." }); } Object.assign(p, dt); }
    else { p = Object.assign({ id: "p-" + Date.now().toString(36), text: st.text }, dt); list.push(p); }
    list.sort((a, b) => (a.date + (a.time || "")) < (b.date + (b.time || "")) ? -1 : 1);
    await postsSave(list); await admState(null);
    return tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: `✅ ${st.mode === "date" ? "Перенесла" : "Запланировала"}:\n\n${postHead(p)}\n\n${postBody(p)}`, reply_markup: kbPost(p) });
  }
  await admState(null); return null;
}
async function postAction(d, chat, m) {
  const [act, id] = d.split("|"); const cfg = await clubFull(); const list = (cfg.posts || []).slice(); const p = list.find(x => x.id === id);
  const cancel = { inline_keyboard: [[{ text: "Отмена", callback_data: "pcancel" }]] };
  if (act === "pcancel") { await admState(null); return tg("sendMessage", { chat_id: chat, text: "Отменила." }); }
  if (act === "pn") { await admState({ mode: "new" }); return tg("sendMessage", { chat_id: chat, text: "Пришли текст нового анонса. Его получат все участники.", reply_markup: cancel }); }
  if (!p) return tg("sendMessage", { chat_id: chat, text: "Этот анонс уже удалён или отправлен." });
  if (act === "pe") { await admState({ mode: "edit", id }); return tg("sendMessage", { chat_id: chat, text: "Пришли новый текст для этого анонса." + (/\{winner\}/.test(p.text) ? " Чтобы бот подставил имя победителя, напиши в тексте {winner}." : ""), reply_markup: cancel }); }
  if (act === "pd") { await admState({ mode: "date", id }); return tg("sendMessage", { chat_id: chat, text: "Новая дата и время? Например: 25.11 19:00", reply_markup: cancel }); }
  if (act === "px") return tg("sendMessage", { chat_id: chat, text: `Удалить анонс на ${ru(p.date)}?`, reply_markup: { inline_keyboard: [[{ text: "🗑 Да, удалить", callback_data: "pxy|" + id }, { text: "Нет", callback_data: "pcancel" }]] } });
  if (act === "pxy") { await postsSave(list.filter(x => x.id !== id)); if (m) await tg("editMessageReplyMarkup", { chat_id: chat, message_id: m.message_id, reply_markup: { inline_keyboard: [] } }); return tg("sendMessage", { chat_id: chat, text: "Удалила ✅" }); }
}
async function adminCmd(text, chat, u) {
  const map = { [AB.stats]: "/stats", [AB.users]: "/users", [AB.club]: "/club", [AB.winner]: "/winner", [AB.votes]: "/votes", [AB.posts]: "/posts", [AB.bc]: "/bc", [AB.fb]: "/feedback" };
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
    if (!ps.length) return tg("sendMessage", { chat_id: chat, text: "Запланированных анонсов нет.", reply_markup: { inline_keyboard: [[{ text: "➕ Новый анонс", callback_data: "pn" }]] } });
    for (const p of ps.slice(0, 10)) await tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: postHead(p) + "\n\n" + postBody(p), reply_markup: kbPost(p) });
    return tg("sendMessage", { chat_id: chat, text: "Это анонсы, которые уйдут всем участникам. Меняй прямо здесь кнопками под каждым.", reply_markup: { inline_keyboard: [[{ text: "➕ Новый анонс", callback_data: "pn" }]] } });
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
  if (cmd === "/feedback") return fbSummary(chat);
  if (cmd === "/admin") {
    return tg("sendMessage", { chat_id: chat, reply_markup: kbAdmin(), text: "Команды админа (всё то же есть кнопками внизу):\n/stats — цифры клуба\n/users — последние 15 участников\n/club — таблица челленджа\n/winner — случайный победитель среди прошедших все дни\n/give @nick 30 — открыть доступ на 30 дней\n/reply ID текст — ответить участнику\n/broadcast текст — рассылка всем\n/posts — анонсы: изменить, перенести, удалить, добавить\n/feedback — отзывы участников за неделю\n/test — проверить, приходят ли напоминания\n\nМожно и проще: ответь (свайп влево) на пересланное сообщение — ответ уйдёт человеку." });
  }
  return null;
}
// ---------- надиктовка в бот: голос или текст с «+» → дела, повторы, траты ----------
const INC_L = { salary: "Зарплата", clients: "Клиенты и заказы", blog: "Блог и соцсети", gift: "Подарки", other_i: "Доход" };
const CAT_L = { food: "🍽 Еда", beauty: "💄 Красота", clothes: "👗 Одежда", rent: "🔑 Жильё", home: "🏠 Дом", transport: "🚕 Транспорт", fun: "🎉 Развлечения", health: "💊 Здоровье", gifts: "🎁 Подарки", study: "📚 Обучение", other: "✨ Другое" };
const REP_L = { daily: "каждый день", weekdays: "по будням", weekly: "каждую неделю", monthly: "каждый месяц" };
const WDS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const REM_T = { 15: "за 15 минут", 60: "за час", 1440: "накануне в 10:00" };
// «за день» — всегда накануне в 10:00; дело без времени с напоминанием — в 10:00 в этот день
function remAt(date, tm, rem) {
  if (!rem) return 0;
  if (rem === 1440) return Date.parse(`${addDays(date, -1)}T10:00:00+03:00`);
  if (!tm) return Date.parse(`${date}T10:00:00+03:00`);
  return Date.parse(`${date}T${tm}:00+03:00`) - rem * 60000;
}
function remText(x) {
  if (x.rem === 1440) return `🔔 Завтра: ${x.t}${x.tm ? " — в " + x.tm : ""}`;
  if (!x.tm) return `🔔 Сегодня: ${x.t}`;
  return `🔔 ${{ 15: "Через 15 минут", 60: "Через час" }[x.rem] || "Скоро"}: ${x.t} — в ${x.tm}`;
}
const dLabel = d => d === mskDay() ? "сегодня" : d === addDays(mskDay(), 1) ? "завтра" : d.slice(0, 4) === mskDay().slice(0, 4) ? ruShort(d) : ru(d);
async function stt(fileId) {
  const f = await tg("getFile", { file_id: fileId }); if (!f.ok) throw new Error("getFile");
  const audio = Buffer.from(await (await fetch(`${TG_BASE()}/file/bot${TOKEN()}/${f.result.file_path}`)).arrayBuffer());
  const r = await fetch("https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?lang=ru-RU&format=oggopus", { method: "POST", headers: { Authorization: "Bearer " + IAM }, body: audio });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0, 200));
  return (j.result || "").trim();
}
function dictPreview(p) {
  const lines = [];
  p.tasks.forEach(x => lines.push(x.rep ? `🔁 ${esc(x.t)}${x.tm ? " · " + x.tm : ""} — ${x.rep === "weekly" && x.dows.length ? x.dows.map(d => WDS[d]).join(", ") : REP_L[x.rep] || ""}` : `📅 ${esc(x.t)} — ${dLabel(x.date)}${x.tm ? " в " + x.tm : ""}${x.rem ? " · 🔔 " + (x.rem === 1440 ? "напомню накануне в 10:00" : x.tm ? "напомню " + REM_T[x.rem] : "напомню в этот день в 10:00") : ""}`));
  p.money.forEach(x => lines.push(x.inc ? `💰 +${x.amount.toLocaleString("ru-RU")} ₽ — ${INC_L[x.src] || "доход"}${x.note ? " · " + esc(x.note) : ""}` : `💸 ${x.amount.toLocaleString("ru-RU")} ₽ — ${CAT_L[x.cat]}${x.note ? " · " + esc(x.note) : ""}`));
  return lines.join("\n");
}
// похоже ли сообщение на дело или деньги (иначе это письмо Яне)
function looksLikeEntry(t) { const low = t.toLowerCase().replace(/ё/g, "е"); if (low.length > 300) return false;
  return /(\d\s*(р|руб|₽|тыс|к)(\s|$|\.)|потрат|заплат|купил|оплатил|получил|заработал|зарплат|перевел|доход|расход|плюс\s+\d)/.test(low) || /^(завтра|сегодня|послезавтра|в понедельник|во вторник|в среду|в четверг|в пятницу|в субботу|в воскресенье|каждый|каждую|каждое|запиши|добавь|купить|позвонить|записаться|сделать|отправить|оплатить|забрать|встреча|созвон)/.test(low) || /напомни/.test(low); }
async function dictStart(chat, u, text, heard) {
  const p = parseAll(text, mskDay());
  if (!p.tasks.length && !p.money.length) return tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: `${heard ? `🎤 Услышала: «${esc(text)}»\n\n` : ""}Не нашла здесь дел или трат. Скажи, например: «завтра в 6 парикмахер, напомни за час» или «потратила 500 на такси».` });
  await db().kvPut(u.id, { _dict: JSON.stringify(p) });
  return tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: `${heard ? `🎤 Услышала: «${esc(text)}»\n\n` : ""}Записать?\n\n${dictPreview(p)}`, reply_markup: { inline_keyboard: [[{ text: "✅ Записать", callback_data: "dadd" }], [{ text: "✏️ Изменить", callback_data: "dfix" }, { text: "🗑 Удалить", callback_data: "dno" }]] } });
}
function bigGet(kv, name) { if (kv[name + "__n"]) { let s = ""; for (let i = 0; i < +kv[name + "__n"]; i++) s += kv[`${name}__${i}`] || ""; try { return JSON.parse(s); } catch (e) { return null; } } if (kv[name]) { try { return JSON.parse(kv[name]); } catch (e) { return null; } } return null; }
function bigPut(kv, name, val, put, del) { const str = JSON.stringify(val); const parts = []; for (let i = 0; i < str.length; i += 3800) parts.push(str.slice(i, i + 3800)); if (!parts.length) parts.push("null");
  parts.forEach((p, i) => put[`${name}__${i}`] = p); put[name + "__n"] = String(parts.length); const old = +kv[name + "__n"] || 0; for (let i = parts.length; i < old; i++) del.push(`${name}__${i}`); if (kv[name]) del.push(name); }
async function dictApply(u) {
  const kv = await db().kvAll(u.id); let p; try { p = JSON.parse(kv._dict || "null"); } catch (e) { p = null; } if (!p) return null;
  const put = {}, del = ["_dict"], days = {}; const today = mskDay(); let nT = 0, nM = 0;
  const dayOf = k => days[k] || (days[k] = (() => { try { return JSON.parse(kv["d_" + k] || "null"); } catch (e) { return null; } })() || { done: [], tasks: [], water: 0 });
  const recs = p.tasks.filter(x => x.rep);
  if (recs.length) { const rec = bigGet(kv, "rec") || []; recs.forEach(x => rec.push({ id: "v" + crypto.randomBytes(4).toString("hex"), t: x.t, tm: x.tm || "", rep: x.rep, dows: x.dows || [], dom: x.dom || null, from: x.from || today })); bigPut(kv, "rec", rec, put, del); nT += recs.length; }
  for (const x of p.tasks.filter(x => !x.rep)) {
    const d = dayOf(x.date || today); d.tasks = (d.tasks || []).concat(Object.assign({ t: x.t, d: false, tm: x.tm || "" }, x.rem ? { rem: x.rem } : {})); nT++;
    if (x.rem && db().remAdd) { const at = remAt(x.date || today, x.tm, x.rem); if (at > Date.now()) await db().remAdd(u.id, { id: `b${(x.date || today).replace(/-/g, "")}${crypto.randomBytes(3).toString("hex")}`, at, text: remText(x) }); }
  }
  for (const x of p.money) { const d = dayOf(today); if (x.inc) d.inc = (d.inc || []).concat([[x.amount, x.note || "", x.src || "other_i"]]); else d.exp = (d.exp || []).concat([[x.amount, x.cat, x.note || ""]]); nM++; }
  for (const [k, d] of Object.entries(days)) put["d_" + k] = JSON.stringify(d);
  await db().kvPut(u.id, put, del);
  return { nT, nM };
}

async function onMessage(m) {
  const chat = m.chat.id; if (m.chat.type !== "private") return;
  const text = (m.text || "").trim();
  if (text === "/myid") return tg("sendMessage", { chat_id: chat, text: `Твой id: ${m.from.id}` });
  if (!isTester(m.from.id)) return tg("sendMessage", { chat_id: chat, text: T.soon });
  const u = await touch(m.from); const isAdmin = +m.from.id === ADMIN();
  const fo = m.forward_origin || (m.forward_from_chat ? { type: "channel", chat: m.forward_from_chat } : null);
  if (isAdmin && fo && fo.type === "channel" && fo.chat) {
    const id = fo.chat.id; const me = await tg("getChatMember", { chat_id: id, user_id: +String(TOKEN()).split(":")[0] }); const r = me.ok ? me.result : {};
    const st = r.status === "administrator" ? (r.can_invite_users ? "Бот — админ канала с правом приглашать ✅" : "Бот — админ, но без права «Добавление участников» ❌ Включи его в настройках админа.") : "Бот пока не админ канала ❌ Добавь его в администраторы с правом «Добавление участников».";
    return tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: `Канал «${esc(fo.chat.title || "")}»\nid: <code>${id}</code>\n\n${st}\n\n${String(CLUB_CHAT()) === String(id) ? "Этот канал уже подключён как канал клуба ✅" : "Впиши этот id в переменную CLUB_CHAT_ID функции в Yandex Cloud — и канал подключится."}` });
  }
  const refM = text.match(/^\/start ref_(\d+)/); if (refM && !u.ref && !u.consent && +refM[1] !== +u.id) { u.ref = +refM[1]; await db().putUser(u); }
  if (!u.consent) { if (text.startsWith("/start")) return sendConsent(chat); return tg("sendMessage", { chat_id: chat, text: T.consentNeed, reply_markup: kbConsent() }); }
  if (text.startsWith("/start")) { if (/pay/.test(text)) return sendPay(chat, u); await sendInClub(chat, u); if (isAdmin) await tg("sendMessage", { chat_id: chat, text: T.adminHi, reply_markup: kbAdmin() }); if (/plans/.test(text)) await tg("sendMessage", { chat_id: chat, text: T.plans(freeLabel(), isFounder(u)), parse_mode: "HTML", reply_markup: kbPlans() }); return; }
  if (text === "/club") { const a = access(u); const line = a.ok && a.until ? `\n\n${T.accLine(a, ru(a.until), a.gift ? ru(a.gift) : "")}` : ""; if (await isMember(u)) return tg("sendMessage", { chat_id: chat, text: T.clubIn + line, reply_markup: { inline_keyboard: [[btnApp()]] } }); await sendClubInvite(chat); if (line) await tg("sendMessage", { chat_id: chat, text: line.trim() }); return; }
  if (text === "/invite" || text === "/start invite") return sendInvite(chat, u);
  if (flags(u).has("fbt") && text && !text.startsWith("/")) {
    const f = flags(u); f.delete("fbt"); setFlags(u, f); await db().putUser(u);
    const key = `fb_${u.fbwk || weekKey()}_${u.id}`; const sys = await db().kvAll(0); let o = {}; try { o = JSON.parse(sys[key] || "{}"); } catch (e) {}
    o.t = text.slice(0, 500); o.n = (u.name || "").split(" ")[0]; await db().kvPut(0, { [key]: JSON.stringify(o) });
    if (ADMIN()) await tg("sendMessage", { chat_id: ADMIN(), parse_mode: "HTML", text: `💬 <b>Отзыв недели</b> от ${esc(u.name)} (${o.s || "—"}/5)\n\n${esc(o.t)}\n\nid: ${u.id}` });
    return tg("sendMessage", { chat_id: chat, text: T.fbThanks });
  }
  if (text === "/app") return tg("sendMessage", { chat_id: chat, text: T.openApp, reply_markup: { inline_keyboard: [[btnApp()]] } });
  if (text === "/plans") return tg("sendMessage", { chat_id: chat, text: PAID() ? T.plans(freeLabel(), isFounder(u)) : T.freeClub, parse_mode: "HTML", reply_markup: kbPlans() });
  if (text === "/help") return tg("sendMessage", { chat_id: chat, text: T.faq(ADMIN_NICK()), parse_mode: "HTML", disable_web_page_preview: true, reply_markup: kbBack() });
  if (text === "/delete") return tg("sendMessage", { chat_id: chat, text: T.delAsk, reply_markup: { inline_keyboard: [[{ text: "🗑 Да, удалить всё", callback_data: "delyes" }], [{ text: "Нет, оставить", callback_data: "delno" }]] } });
  if (m.voice || m.audio) {
    const v = m.voice || m.audio; if ((v.duration || 0) > 60) return tg("sendMessage", { chat_id: chat, text: "🎤 Голосовое длиннее минуты — запиши, пожалуйста, покороче." });
    let heard = ""; try { heard = await stt(v.file_id); } catch (e) { console.log("stt", e && e.message); return tg("sendMessage", { chat_id: chat, text: "🎤 Не получилось распознать. Попробуй ещё раз или напиши текстом, начав с «+»." }); }
    if (!heard) return tg("sendMessage", { chat_id: chat, text: "🎤 Ничего не расслышала. Попробуй ещё раз, чуть ближе к телефону." });
    return dictStart(chat, u, heard, true);
  }
  if (text.startsWith("+") && text.length > 2) return dictStart(chat, u, text.slice(1).trim(), false);
  if (/^\/(тест|test)$/i.test(text)) {
    await db().kvPut(0, { ["test_" + u.id]: String(Date.now() + 60e3) });
    const last = +((await db().kvAll(0)).last_tick || 0), ago = last ? Math.round((Date.now() - last) / 60000) : null;
    let msg = "⏱ Поставила тестовое напоминание. Оно придёт через 1–2 минуты.";
    if (ago === null) msg += "\n\n⚠️ Но таймер ещё ни разу не будил бота, поэтому напоминания сейчас не приходят." + (isAdmin ? " Нужно создать триггер-таймер в Yandex Cloud." : " Я уже сообщила Яне.");
    else if (ago > 10) msg += `\n\n⚠️ Таймер последний раз срабатывал ${ago} мин назад. Похоже, он выключен.`;
    else if (isAdmin) msg += `\n\nТаймер работает: последний раз ${ago} мин назад ✅`;
    if (ago === null && !isAdmin && ADMIN()) await tg("sendMessage", { chat_id: ADMIN(), text: "⚠️ Напоминания не уходят: таймер ни разу не запускал бота. Создай триггер-таймер для функции." });
    return tg("sendMessage", { chat_id: chat, text: msg });
  }
  if (text === "/remind") { const f = flags(u); f.delete("nocr"); setFlags(u, f); await db().putUser(u); return tg("sendMessage", { chat_id: chat, text: T.chOn }); }
  if (isAdmin) {
    const fwd = (m.forward_origin && m.forward_origin.chat) || m.forward_from_chat;
    if (fwd) return tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: `ID канала «${esc(fwd.title || "")}»: <code>${fwd.id}</code>\n\nВставь его в переменные функции как CLUB_CHAT_ID и добавь меня (бота) админом канала с правом «Добавлять участников».` });
    if (text && !text.startsWith("/") && !Object.values(AB).includes(text)) { const r = await adminText(text, chat); if (r !== null && r !== undefined) return r; }
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
  if (text && !text.startsWith("/") && looksLikeEntry(text)) {
    const p = parseAll(text, mskDay());
    if (p.tasks.length || p.money.length) { await db().kvPut(u.id, { _dict: JSON.stringify(p), _dmsg: text.slice(0, 3000) });
      return tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: `Записать?\n\n${dictPreview(p)}`, reply_markup: { inline_keyboard: [[{ text: "✅ Записать", callback_data: "dadd" }], [{ text: "💬 Нет, это сообщение Яне", callback_data: "dmsg" }]] } }); }
  }
  if (text && !text.startsWith("/") && ADMIN()) {
    await tg("sendMessage", { chat_id: ADMIN(), parse_mode: "HTML", text: `💬 <b>${esc(u.name)}</b>${u.username ? " @" + esc(u.username) : ""}\nid: ${u.id}\n\n${esc(text)}\n\n<i>Ответь на это сообщение — ответ уйдёт человеку</i>` });
    return tg("sendMessage", { chat_id: chat, text: T.supportSent });
  }
}
async function onCallback(cq) {
  const d = cq.data, m = cq.message; await tg("answerCallbackQuery", { callback_query_id: cq.id });
  if (!m) return; if (!isTester(cq.from.id)) return tg("sendMessage", { chat_id: m.chat.id, text: T.soon });
  let u = await touch(cq.from); const chat = m.chat.id;
  if (d.startsWith("v|")) { // голосование
    const [, pid, i] = d.split("|"); const cfg = await clubFull(); const vp = (cfg.posts || []).find(p => p.id === pid && p.vote);
    if (!vp || !vp.vote[+i]) return; if (!u.consent) return sendConsent(chat);
    await db().clubJoin("vote|" + pid, u.id, String(+i));
    return tg("sendMessage", { chat_id: chat, text: T.voteThanks(vp.vote[+i]) });
  }
  if (+cq.from.id === ADMIN()) {
    if (d === "reroll") return adminCmd("/winner", chat, u);
    if (/^(pe|pd|px|pxy|pn|pcancel)(\||$)/.test(d)) return postAction(d, chat, m);
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
    await refFriend(u); // неделя другу по приглашению — сразу после согласия
    if (!CLUB_CHAT()) await refOnJoin(u);
    return sendInClub(chat, u, true);
  }
  if (!u.consent) return sendConsent(chat);
  if (d.startsWith("fb|")) {
    const [, wk, n] = d.split("|"); const key = `fb_${wk}_${u.id}`;
    await db().kvPut(0, { [key]: JSON.stringify({ s: +n, n: (u.name || "").split(" ")[0] }) });
    const f = flags(u); f.add("fbt"); setFlags(u, f); u.fbwk = wk; await db().putUser(u);
    await tg("editMessageReplyMarkup", { chat_id: chat, message_id: m.message_id, reply_markup: { inline_keyboard: [] } });
    return tg("sendMessage", { chat_id: chat, text: T.fbMore(+n), reply_markup: { inline_keyboard: [[{ text: "Пропустить", callback_data: "fbskip" }]] } });
  }
  if (d === "fbskip") { const f = flags(u); f.delete("fbt"); setFlags(u, f); await db().putUser(u); await tg("editMessageReplyMarkup", { chat_id: chat, message_id: m.message_id, reply_markup: { inline_keyboard: [] } }); return tg("sendMessage", { chat_id: chat, text: T.fbThanks }); }
  if (d === "invite") return sendInvite(chat, u);
  if (d === "dadd") { const r = await dictApply(u); await tg("editMessageReplyMarkup", { chat_id: chat, message_id: m.message_id, reply_markup: { inline_keyboard: [] } }); if (!r) return tg("sendMessage", { chat_id: chat, text: "Это уже записано или устарело. Надиктуй ещё раз 🎤" }); return tg("sendMessage", { chat_id: chat, text: `Записала ✓ ${[r.nT ? `дел: ${r.nT}` : "", r.nM ? `в деньгах: ${r.nM}` : ""].filter(Boolean).join(", ")}`, reply_markup: { inline_keyboard: [[btnApp("Открыть приложение")]] } }); }
  if (d === "dmsg") { const kv = await db().kvAll(u.id); const t = kv._dmsg || ""; await db().kvPut(u.id, {}, ["_dict", "_dmsg"]); await tg("editMessageReplyMarkup", { chat_id: chat, message_id: m.message_id, reply_markup: { inline_keyboard: [] } });
    if (t && ADMIN()) await tg("sendMessage", { chat_id: ADMIN(), parse_mode: "HTML", text: `💬 <b>${esc(u.name)}</b>${u.username ? " @" + esc(u.username) : ""}\nid: ${u.id}\n\n${esc(t)}\n\n<i>Ответь на это сообщение — ответ уйдёт человеку</i>` });
    return tg("sendMessage", { chat_id: chat, text: T.supportSent }); }
  if (d === "dno") { await db().kvPut(u.id, {}, ["_dict"]); await tg("editMessageReplyMarkup", { chat_id: chat, message_id: m.message_id, reply_markup: { inline_keyboard: [] } }); return tg("sendMessage", { chat_id: chat, text: "Удалила, ничего не записываю." }); }
  if (d === "dfix") { await db().kvPut(u.id, {}, ["_dict"]); await tg("editMessageReplyMarkup", { chat_id: chat, message_id: m.message_id, reply_markup: { inline_keyboard: [] } }); return tg("sendMessage", { chat_id: chat, text: "Скажи или напиши ещё раз, как правильно. Например: «21 ноября стоматолог в 15:00, напомни за день» 🎤" }); }
  if (d === "delyes") { await db().deleteUser(u.id); await tg("editMessageReplyMarkup", { chat_id: chat, message_id: m.message_id, reply_markup: { inline_keyboard: [] } }); return tg("sendMessage", { chat_id: chat, text: T.delDone }); }
  if (d === "delno") return tg("editMessageText", { chat_id: chat, message_id: m.message_id, text: "Хорошо, ничего не удаляю 🖤" });
  if (d === "choff") { const f = flags(u); f.add("nocr"); setFlags(u, f); await db().putUser(u); return tg("sendMessage", { chat_id: chat, text: T.chOff }); }
  const pages = { inside: [T.inside, kbBack()], plans: [PAID() ? T.plans(freeLabel(), isFounder(u)) : T.freeClub, kbPlans()], faq: [T.faq(ADMIN_NICK()), kbBack()], back: [T.welcome(freeLabel()), kbMain()] };
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
  if (!isTester(user.id)) return [200, { ok: false, kind: "soon", consent: true, docs: T.DOCS }];
  let u = await touch(user);
  if (action === "agree") { if (!u.consent) u = await agree(u, user); return [200, { ok: true, consent: true }]; }
  if (action === "me") {
    if (u.consent && !u.trial && +u.id !== ADMIN()) { u.trial = String(Date.now()); await db().putUser(u); }
    const acc = access(u);
    if (u.consent && acc.ok && CLUB_CHAT() && !(await isMember(u))) return [200, { ...acc, ok: false, kind: "club", clubLink: await clubLink(), consent: true, docs: T.DOCS, bot: env("BOT_USERNAME") }];
    return [200, { ...acc, consent: !!u.consent, docs: T.DOCS, freeUntil: PAID() && isFree() ? FREE_UNTIL() : "", trialDays: TRIAL_DAYS(), admin: +u.id === ADMIN(), bot: env("BOT_USERNAME"), joined: +u.trial || +u.created || 0, refn: +u.refn || 0, refs: String(u.refs || "").split(",").filter(Boolean), ref: refLink(u), giftEnd: u.gift || "", freeLast: lastFreeDay(), plans: plansFor(u).map(p => ({ id: p.id, t: p.t, e: p.e, price: p.price, note: p.note || "", url: isFree() ? null : payLink(u, p) })) }];
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
    const isL = r => /^letter-/.test(r.id || "");
    const list = (Array.isArray(body.list) ? body.list : []).filter(r => r && /^[\w.-]{1,60}$/.test(r.id || "") && +r.at > now - 60e3 && +r.at < now + (isL(r) ? 400 : 40) * DAY && typeof r.text === "string").slice(0, 200)
      .map(r => ({ id: r.id, at: Math.round(+r.at), text: r.text.slice(0, isL(r) ? 3500 : 300) }));
    await db().remSet(u.id, list);
    return [200, { ok: true, n: list.length }];
  }
  if (action === "club") {
    const op = body.op;
    // голосование за следующую привычку — тот же счёт, что и кнопки в боте
    if (op === "vote" || op === "votes") {
      const cfg = await clubFull(); const vp = (cfg.posts || []).find(p => p.id === String(body.pid || "") && p.vote); if (!vp) return [404, { error: "vote" }];
      if (op === "vote" && vp.vote[+body.i] != null) await db().clubJoin("vote|" + vp.id, u.id, String(+body.i));
      const ms = await db().clubMembers("vote|" + vp.id); const mine = ms.find(m => +m.uid === +u.id);
      return [200, { opts: vp.vote, n: vp.vote.map((o, i) => ms.filter(m => m.name === String(i)).length), mine: mine ? +mine.name : null }];
    }
    // запись на следующий челлендж заранее
    if (op === "reg" || op === "regs") {
      const k = "reg|" + String(body.start || "").slice(0, 10); if (!/^reg\|\d{4}-\d{2}-\d{2}$/.test(k)) return [400, { error: "start" }];
      if (op === "reg") await db().clubJoin(k, u.id, (user.first_name || "").slice(0, 30));
      const ms = await db().clubMembers(k); return [200, { n: ms.length, me: ms.some(m => +m.uid === +u.id) }];
    }
    const ch = String(body.ch || "").slice(0, 60); if (!ch) return [400, { error: "ch" }];
    const day = /^\d{4}-\d{2}-\d{2}$/.test(body.day || "") ? body.day : mskDay();
    const nm = (user.first_name || "").slice(0, 30);
    if (op === "card") { // карточка для сторис: приложение рисует картинку, бот присылает её в чат
      const img = String(body.img || "").replace(/^data:image\/\w+;base64,/, ""); if (!img || img.length > 4e6) return [400, { error: "img" }];
      const r = await tgPhoto(u.id, Buffer.from(img, "base64"), T.cardCaption()); return [200, { ok: !!r.ok }];
    }
    if (op === "join") await db().clubJoin(ch, u.id, nm);
    if (op === "mark") {
      const c = (await clubConfig()).find(x => x.id === ch);
      const v = body.v === 1 || body.v === 0 ? body.v : null;
      if (c && c.win && v !== null) { // отметка только в окне времени и только за сегодня
        const t = mskMin();
        if (day !== mskDay() || t < hm(c.win[0]) || t >= hm(c.win[1])) return [409, { error: "window", win: c.win }];
      }
      await db().clubJoin(ch, u.id, nm); await db().clubMark(ch, day, u.id, v);
    }
    const today = mskDay();
    if (op === "give") { // подарить цветок: 5 в день, одному человеку — один раз в день, только тем, кто отметился сегодня
      const raw = await db().clubRaw(ch); const to = raw.find(m => pid(m.uid) === String(body.to || ""));
      if (!to || +to.uid === +u.id || !(to.marks && to.marks[today] === 1)) return [409, { error: "to" }];
      const res = await db().clubPatch(ch, u.id, m => { m.gg = m.gg || {}; for (const d of Object.keys(m.gg)) if (d < addDays(today, -40)) delete m.gg[d]; const l = m.gg[today] || []; if (l.length >= 5 || l.includes(+to.uid)) return false; m.gg[today] = l.concat(+to.uid); if (!m.name) m.name = nm; return true; });
      if (res) { await db().clubPatch(ch, to.uid, m => { m.gr = (m.gr || 0) + 1; }); const tu = await db().getUser(to.uid); if (tu) { tu.bq = (tu.bq || 0) + 1; await db().putUser(tu); } }
    }
    const st = await db().clubStats(ch, op === "stats" ? day : today);
    const av = typeof body.av === "string" && /^(a:\d{1,2}|tg:https:\/\/t\.me\/i\/userpic\/[\w\/.-]{1,200})$/.test(body.av) ? body.av : null;
    const meB = st.board.find(b => b.uid === u.id);
    if (av && meB && meB.av !== av) { await db().clubPatch(ch, u.id, m => { m.av = av; }); meB.av = av; st.feed.forEach(f => { if (f.uid === u.id) f.av = av; }); }
    const raw = op === "give" || st.feed.length ? await db().clubRaw(ch) : [];
    const mine = (raw.find(m => +m.uid === +u.id) || {}); const given = ((mine.gg || {})[today] || []).map(Number);
    const me = await db().getUser(u.id);
    const top = st.board.filter(b => b.g > 0).sort((a, b) => b.g - a.g).slice(0, 10).map(b => ({ name: b.name, av: b.av, g: b.g, me: b.uid === u.id }));
    st.board = st.board.map(b => ({ name: b.name, n: b.n, av: b.av, gr: b.gr, me: b.uid === u.id }));
    st.feed = (st.feed || []).slice(0, 80).map(f => ({ id: pid(f.uid), name: f.name, at: f.at, av: f.av, gr: f.gr, me: f.uid === u.id, gifted: given.includes(f.uid) }));
    st.top = top; st.gifts = { left: Math.max(0, 5 - given.length), gr: meB ? meB.gr || 0 : 0, bq: (me && me.bq) || 0 };
    return [200, st];
  }
  if (action === "delete") { await db().deleteUser(u.id); return [200, { ok: true }]; }
  if (action === "prefs") { const f = flags(u); if (body.challenge === false) f.add("nocr"); else if (body.challenge === true) f.delete("nocr"); setFlags(u, f); await db().putUser(u); return [200, { ok: true }]; }
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
  try { const r = await fetch(APP_URL().replace(/\/?$/, "/") + "club.json?t=" + Date.now()); const j = await r.json(); CLUBF = j || {}; CLUB = (j.challenges || []).filter(c => c && c.id && c.start && c.len); CLUB_AT = Date.now();
    try { const sp = (await db().kvAll(0)).posts; if (sp) CLUBF.posts = JSON.parse(sp); } catch (e) {} } // анонсы, изменённые в боте, важнее файла
  catch (e) { console.log("club.json", e && e.message); CLUBF = CLUBF || { challenges: CLUB || [] }; CLUB = CLUB || []; }
  return CLUBF;
}
async function clubConfig() { await clubFull(); return CLUB || []; }
// Анонсы по расписанию: club.json → posts: [{id, date, time, text, vote?: [варианты], app?: true}]
async function scheduledPosts() {
  const cfg = await clubFull(); const today = mskDay(), t = mskMin(); let sent = 0;
  for (const p of cfg.posts || []) {
    if (!p || !p.id || p.date !== today || t < hm(p.time || "12:00") || t > hm(p.time || "12:00") + 120) continue;
    let text = String(p.text || ""); let rep = null;
    if (p.report) { rep = await challengeReport(p.report); if (rep) text = rep.text; }
    if (text.includes("{winner}")) {
      const ch = p.ch || ((cfg.challenges || [])[0] || {}).id; const w = (await db().kvAll(0))["winner_" + ch];
      if (!w) { if (await db().once(`postwait|${p.id}|${today}|${Math.floor(t / 30)}`) && ADMIN()) await tg("sendMessage", { chat_id: ADMIN(), text: "⏳ Анонс итогов ждёт победителя — нажми «🎁 Выбрать победителя», и я сразу разошлю.", reply_markup: kbAdmin() }); continue; }
      text = text.replace(/\{winner\}/g, JSON.parse(w).name);
    }
    if (/\{[a-z]+\}/.test(text)) { if (await db().once(`postbad|${p.id}`) && ADMIN()) await tg("sendMessage", { chat_id: ADMIN(), text: `⚠️ Анонс на ${ru(p.date)} не отправлен: в тексте не заполнено ${text.match(/\{[a-z]+\}/)[0]}. Напиши мне в Claude, что вставить.` }); continue; }
    if (!(await db().once("post|" + p.id))) continue;
    const kb = p.vote ? { inline_keyboard: p.vote.map((o, i) => [{ text: o, callback_data: `v|${p.id}|${i}` }]) } : { inline_keyboard: [[btnApp()]] };
    const n = await broadcast(text, kb, { parse_mode: "HTML" }); sent += n.ok;
    if (rep) sent += await personalResults(rep.c, rep.board);
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
  // кто не отмечался два дня подряд — утром получает мягкое «мы тебя ждём»
  let away = new Set();
  if (kind === "m" && n >= 3) { const y1 = new Set((await db().clubDayMarks(c.id, addDays(today, -1))).filter(x => +x.v === 1).map(x => +x.uid)), y2 = new Set((await db().clubDayMarks(c.id, addDays(today, -2))).filter(x => +x.v === 1).map(x => +x.uid)); away = new Set(members.map(m => +m.uid).filter(id => !y1.has(id) && !y2.has(id))); }
  for (const mb of members) {
    if (done.has(+mb.uid)) continue;
    const u = await db().getUser(mb.uid); if (!u || !u.consent || flags(u).has("nocr")) continue;
    const text = kind === "m" ? (away.has(+mb.uid) ? T.chMissed(c.title, n, c.len, c.win[1]) : T.chMorning(c.title, n, c.len, c.win[0], c.win[1])) : T.chLate(c.title, c.win[1]);
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
  // пробные напоминания по команде /тест
  const sys = await db().kvAll(0); const tests = Object.entries(sys).filter(([k, v]) => /^test_\d+$/.test(k) && +v <= now);
  for (const [k] of tests) { const x = await tg("sendMessage", { chat_id: +k.slice(5), text: "🔔 Тестовое напоминание пришло. Напоминания работают ✅" }); if (x.ok) sent++; }
  if (tests.length) await db().kvPut(0, {}, tests.map(([k]) => k));
  return sent;
}
async function accessReminders() {
  const today = mskDay(), now = Date.now();
  if (isFree() || mskMin() < 10 * 60 || mskMin() > 21 * 60) return 0; // пишем про оплату только днём
  const us = await db().listUsers(); let sent = 0;
  for (const u of us) {
    if (+u.id === ADMIN() || !u.consent) continue;
    const rem = flags(u); let msg = null, flag = null;
    const acc = access(u); const until = acc.ok && (acc.kind === "paid" || acc.kind === "gift") ? acc.until : "";
    const paidActive = !!until; const end = trialEnd(u);
    if (paidActive && acc.kind === "gift" && now >= freeEnd() && now < freeEnd() + DAY && !rem.has("g1")) { msg = T.giftNow(ru(until)); flag = "g1"; }
    else if (!paidActive && end) {
      const createdInFree = +u.trial < freeEnd();
      if (createdInFree && now >= freeEnd() && now < freeEnd() + DAY && !rem.has("f1")) { msg = T.freeOver; flag = "f1"; }
      else if (now >= end - DAY && now < end && !rem.has("t1")) { msg = T.trialSoon; flag = "t1"; }
      else if (now >= end && now < end + 7 * DAY && !rem.has("t2") && !u.paid) { msg = T.trialOver; flag = "t2"; }
    }
    if (paidActive && until <= addDays(today, 1) && !rem.has("p" + until)) { msg = acc.kind === "gift" ? T.giftSoon(ru(until)) : T.paidSoon(ru(until)); flag = "p" + until; }
    if (!access(u).ok && u.mem) await kickExpired(u);
    if (msg) { const r = await tg("sendMessage", { chat_id: u.id, text: msg, reply_markup: kbPay() }); rem.add(flag); setFlags(u, rem); await db().putUser(u); if (r.ok) sent++; await sleep(40); }
  }
  return sent;
}
// ---------- отзыв раз в неделю (тестовый месяц): воскресенье, 18:00 по Москве ----------
const weekKey = (d = mskDay()) => addDays(d, -((new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7)); // понедельник этой недели
async function weeklyFeedback() {
  const today = mskDay();
  if (!isFree() || new Date(today + "T12:00:00Z").getUTCDay() !== 0 || mskMin() < 18 * 60 || mskMin() > 21 * 60 || today < "2026-11-08") return 0;
  if (!(await db().once("fb|" + today))) return 0;
  const wk = weekKey(today); const kb = { inline_keyboard: [[1, 2, 3, 4, 5].map(n => ({ text: String(n), callback_data: `fb|${wk}|${n}` }))] };
  const us = (await db().listUsers()).filter(u => u.consent && +u.id !== ADMIN()); let ok = 0;
  for (const u of us) { const r = await tg("sendMessage", { chat_id: u.id, text: T.fbAsk, reply_markup: kb }); if (r.ok) ok++; await sleep(40); }
  return ok;
}
async function fbSummary(chat) {
  const sys = await db().kvAll(0); const wk = weekKey();
  const all = Object.entries(sys).filter(([k]) => k.startsWith("fb_")).map(([k, v]) => { try { return Object.assign({ wk: k.split("_")[1] }, JSON.parse(v)); } catch (e) { return null; } }).filter(Boolean);
  const last = all.filter(x => x.wk === all.map(y => y.wk).sort().pop());
  if (!last.length) return tg("sendMessage", { chat_id: chat, text: "Отзывов пока нет. Бот спрашивает их по воскресеньям в 18:00, начиная с 8 ноября." });
  const avg = last.reduce((a, x) => a + (+x.s || 0), 0) / last.length;
  const txt = last.filter(x => x.t).map(x => `• ${esc(x.n || "")}: ${esc(x.t)} (${x.s})`).join("\n");
  return tg("sendMessage", { chat_id: chat, parse_mode: "HTML", text: `💬 <b>Отзывы за неделю с ${ruShort(last[0].wk)}</b>\nОтветили: ${last.length}\nСредняя оценка: ${avg.toFixed(1)} из 5\n\n${txt || "Комментариев нет."}` });
}

// ---------- «Пригласи друга»: неделя другу и неделя тому, кто пригласил ----------
// В ноябре (бесплатный месяц) пригласившему неделя засчитывается, когда друг вступил в клуб.
// С декабря — когда друг впервые оплатил (так нельзя накрутить недели фейковыми аккаунтами).
// Подаренные недели начинаются после бесплатного ноября и складываются: до 7, до 14 декабря и т. д.
const WEEK = 7;
const refLink = u => env("BOT_USERNAME") ? `https://t.me/${env("BOT_USERNAME")}?start=ref_${u.id}` : "";
const lastFreeDay = () => addDays(FREE_UNTIL(), -1);
function addGift(u, days) { const base = [u.gift || "", u.paid || "", mskDay(), lastFreeDay()].sort().pop(); u.gift = addDays(base, days); setFlags(u, [...flags(u)].filter(x => !x.startsWith("p"))); return u.gift; }
async function sendInvite(chat, u) {
  const link = refLink(u); if (!link) return tg("sendMessage", { chat_id: chat, text: "Ссылка-приглашение скоро появится 🖤" });
  const n = +u.refn || 0;
  return tg("sendMessage", { chat_id: chat, parse_mode: "HTML", disable_web_page_preview: true, text: PAID() ? T.invite(link, n, u.gift && u.gift >= mskDay() ? ru(u.gift) : "", isFree()) : T.inviteFree(link, n), reply_markup: { inline_keyboard: [[{ text: "📤 Отправить другу", url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(PAID() ? T.inviteShare : T.inviteShareFree)}` }]] } });
}
async function refFriend(u) { // неделя другу, который пришёл по ссылке (только в платном режиме)
  if (!PAID()) return;
  if (!u || !u.ref || +u.ref === +u.id || flags(u).has("rg")) return;
  const f = flags(u); f.add("rg"); setFlags(u, f); const until = addGift(u, WEEK); await db().putUser(u);
  await tg("sendMessage", { chat_id: u.id, parse_mode: "HTML", text: T.refWelcome(ru(until), isFree()) });
}
async function refCredit(u) { // неделя тому, кто пригласил
  if (!u || !u.ref || +u.ref === +u.id || flags(u).has("rf")) return;
  const f = flags(u); f.add("rf"); setFlags(u, f); await db().putUser(u);
  const inv = await db().getUser(+u.ref); if (!inv || !inv.consent) return;
  inv.refn = (+inv.refn || 0) + 1;
  if (!PAID()) { const nmf = (u.name || "").split(" ")[0] || "Друг"; inv.refs = [nmf].concat(String(inv.refs || "").split(",").filter(Boolean)).slice(0, 30).join(","); await db().putUser(inv); return tg("sendMessage", { chat_id: inv.id, parse_mode: "HTML", text: T.refThanks(esc(nmf)) }); }
  // в бесплатном ноябре неделя за каждого вступившего друга, но не больше 4 недель
  if (isFree() && (+inv.refnov || 0) >= 4) { const nm0 = (u.name || "").split(" ")[0] || "Друг"; inv.refs = [nm0].concat(String(inv.refs || "").split(",").filter(Boolean)).slice(0, 30).join(","); await db().putUser(inv); return tg("sendMessage", { chat_id: inv.id, parse_mode: "HTML", text: T.refMax(esc(nm0)) }); }
  if (isFree()) inv.refnov = (+inv.refnov || 0) + 1;
  const until = addGift(inv, WEEK);
  const nm = (u.name || "").split(" ")[0] || "Друг"; inv.refs = [nm].concat(String(inv.refs || "").split(",").filter(Boolean)).slice(0, 30).join(",");
  await db().putUser(inv);
  await tg("sendMessage", { chat_id: inv.id, parse_mode: "HTML", text: T.refGot(esc(nm), ru(until), isFree()) });
  if (ADMIN()) await tg("sendMessage", { chat_id: ADMIN(), text: `🎁 ${inv.name} привёл(а) ${u.name}. +1 неделя, клуб открыт до ${ru(until)}` });
}
async function refOnJoin(u) { await refFriend(u); if (isFree()) await refCredit(u); }

// ---------- итоги челленджа: общий пост с цифрами и топом + личный итог каждому ----------
async function challengeReport(chId) {
  const cl = await clubConfig(); const c = cl.find(x => x.id === chId) || (await activeChallenge(true)); if (!c) return null;
  const st = await db().clubStats(c.id, mskDay()); const board = st.board || [];
  const fin = board.filter(b => b.n >= c.len).length, total = board.reduce((a, b) => a + b.n, 0);
  const top = board.filter(b => b.n > 0).slice(0, 10).map((b, i) => `${["🥇", "🥈", "🥉"][i] || (i + 1) + "."} ${esc(b.name)} — ${b.n} из ${c.len}`).join("\n");
  const text = `🏁 <b>Итоги челленджа «${esc(c.title)}»</b>\n\nНачали: ${st.members}\nДошли до конца: ${fin}\nВсего отметок: ${total}\n\n<b>Топ участников</b>\n${top || "—"}\n\nСреди всех, кто прошёл все дни, завтра выберем победителя и подарим подарок 🎁`;
  return { c, board, text };
}
async function personalResults(c, board) {
  let sent = 0;
  for (const b of board) {
    const u = await db().getUser(b.uid); if (!u || !u.consent) continue;
    let mins = 0, zd = 0; try { const kv = await db().kvAll(u.id); for (let i = 0; i < c.len; i++) { const d = JSON.parse(kv["d_" + addDays(c.start, i)] || "null"); if (d && d.zr) { mins += +d.zrm || 6; zd++; } } } catch (e) {}
    if (zd < b.n * 0.8) mins = 0;
    const r = await tg("sendMessage", { chat_id: u.id, parse_mode: "HTML", text: T.myResult(c.title, b.n, c.len, mins), reply_markup: { inline_keyboard: [[btnApp("Открыть мои значки")]] } }); if (r.ok) sent++; await sleep(40);
  }
  return sent;
}

async function reminders() {
  const out = {};
  try { await db().kvPut(0, { last_tick: String(Date.now()) }); } catch (e) {}
  for (const [k, f] of [["tasks", taskReminders], ["challenge", challengeReminders], ["posts", scheduledPosts], ["access", accessReminders], ["feedback", weeklyFeedback]]) {
    try { out[k] = await f(); } catch (e) { console.log("reminders", k, e && e.stack || e); out[k] = "error"; }
  }
  return out;
}

// ---------- setup ----------
async function setup(selfUrl, fid) {
  const out = {};
  const hook = env("TG_API") && fid ? `${TG_BASE()}/hook/${fid}` : selfUrl + "?a=tg";
  out.hook = hook;
  out.webhook = await tg("setWebhook", { url: hook, secret_token: env("WEBHOOK_SECRET"), allowed_updates: ["message", "callback_query", "chat_join_request"], drop_pending_updates: true });
  out.commands = await tg("setMyCommands", { commands: [{ command: "start", description: "Вступить в клуб" }, { command: "app", description: "Открыть приложение" }, { command: "club", description: "Канал клуба" }, ...(PAID() ? [{ command: "plans", description: "Подписка" }] : []), { command: "invite", description: "Пригласить друга" }, { command: "remind", description: "Напоминания о челлендже" }, { command: "help", description: "Вопросы и поддержка" }, { command: "delete", description: "Удалить мои данные" }] });
  out.description = await tg("setMyDescription", { description: T.botDescription });
  out.menu = await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Открыть клуб", web_app: { url: APP_URL() } } });
  if (ADMIN()) out.adminCmds = await tg("setMyCommands", { scope: { type: "chat", chat_id: ADMIN() }, commands: [{ command: "start", description: "Начать и показать кнопки админа" }, { command: "admin", description: "Все команды" }] });
  return out;
}

// ---------- entry ----------
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
const reply = (code, obj) => ({ statusCode: code, headers: { "Content-Type": "application/json; charset=utf-8", ...CORS }, body: JSON.stringify(obj) });
let IAM = "";
module.exports.handler = async function (event, context) {
  IAM = (context && context.token && context.token.access_token) || IAM;
  setS3Token(IAM);
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
      if (body.message) await onMessage(body.message); else if (body.callback_query) await onCallback(body.callback_query); else if (body.chat_join_request) await onJoin(body.chat_join_request);
      return { statusCode: 200, body: "ok" };
    }
    if (["me", "agree", "club", "kv", "rem", "delete", "prefs"].includes(a)) { const [c, o] = await api(a, body); return reply(c, o); }
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
    if (a === "health") return reply(200, { ok: true, db: await db().health(), token: !!TOKEN(), admin: ADMIN() || null, relay: !!env("TG_API"), freeUntil: FREE_UNTIL(), testers: TESTERS().length, club: CLUB_CHAT() || "нет" });
    return reply(200, { ok: true, service: "Life By Me" });
  } catch (e) {
    console.log("ERROR", e && e.stack || e);
    return reply(500, { error: String(e && e.message || e) });
  }
};
module.exports._test = { setClubFull: j => { CLUBF = j; CLUB = (j.challenges || []); CLUB_AT = Date.now(); }, checkInitData, access, setDb, setTgFetch, reminders, mskDay, addDays, prodSign, parseForm, payLink, phpJson, prodSort, setClub: c => { CLUB = c; CLUB_AT = Date.now(); } };
