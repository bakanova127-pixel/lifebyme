// Хранилище: YDB (Yandex Cloud, Россия) или память (для локальных тестов).
const FIELDS = ["name", "username", "created", "trial", "paid", "seen", "rem", "consent"];

function memoryDb() {
  const users = new Map(), members = new Map(), marks = new Map(), kv = new Map(), rems = new Map(), sent = new Set();
  return {
    async getUser(id) { const u = users.get(+id); return u ? { ...u } : null; },
    async putUser(u) { users.set(+u.id, { ...u, id: +u.id }); },
    async listUsers() { return [...users.values()].map(u => ({ ...u })); },
    async clubJoin(ch, uid, name) { const k = ch + "|" + uid; members.set(k, Object.assign({}, members.get(k) || {}, { ch, uid: +uid, name })); },
    async clubPatch(ch, uid, fn) { const k = ch + "|" + uid; const m = members.get(k) || { ch, uid: +uid, name: "" }; const r = fn(m); members.set(k, m); return r; },
    async clubRaw(ch) { return [...members.values()].filter(m => m.ch === ch).map(m => { const mk = {}; for (const x of marks.values()) if (x.ch === ch && x.uid === m.uid) mk[x.day] = x.v; return { ...m, marks: mk }; }); },
    async clubMembers(ch) { return [...members.values()].filter(m => m.ch === ch).map(m => ({ ...m })); },
    async clubMark(ch, day, uid, v) { const k = ch + "|" + day + "|" + uid; if (v == null) marks.delete(k); else marks.set(k, { ch, day, uid: +uid, v, at: Date.now() }); },
    async clubDayMarks(ch, day) { return [...marks.values()].filter(m => m.ch === ch && m.day === day).map(m => ({ ...m })); },
    async clubStats(ch, day) {
      const ms = [...members.values()].filter(m => m.ch === ch);
      const today = [...marks.values()].filter(m => m.ch === ch && m.day === day && m.v === 1);
      const names = today.map(t => (ms.find(m => m.uid === t.uid) || {}).name || "").filter(Boolean);
      const ex = m => ({ av: m.av || "", gr: m.gr || 0, g: Object.values(m.gg || {}).reduce((a, l) => a + l.length, 0) });
      const board = ms.map(m => Object.assign({ uid: m.uid, name: m.name || "", n: [...marks.values()].filter(x => x.ch === ch && x.uid === m.uid && x.v === 1).length }, ex(m))).filter(b => b.name).sort((a, b) => b.n - a.n);
      const feed = today.map(t => { const m = ms.find(x => x.uid === t.uid) || {}; return Object.assign({ uid: t.uid, name: m.name || "", at: t.at || 0 }, ex(m)); }).filter(f => f.name).sort((a, b) => b.at - a.at);
      return { members: ms.length, today: today.length, names, board, feed };
    },
    async remAdd(uid, r) { rems.set(uid + "|" + r.id, { uid: +uid, ...r }); },
    async kvAll(uid) { const o = {}; for (const [k, v] of kv) { const [u, key] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)]; if (+u === +uid) o[key] = v; } return o; },
    async kvPut(uid, put, del) { for (const [k, v] of Object.entries(put || {})) kv.set(uid + "|" + k, v); for (const k of del || []) kv.delete(uid + "|" + k); },
    async remSet(uid, list) { for (const k of [...rems.keys()]) if (k.startsWith(uid + "|")) rems.delete(k); for (const r of list) rems.set(uid + "|" + r.id, { uid: +uid, ...r }); },
    async remDue(now) { return [...rems.values()].filter(r => r.at <= now).map(r => ({ ...r })); },
    async remDel(list) { for (const r of list) rems.delete(r.uid + "|" + r.id); },
    async once(key) { if (sent.has(key)) return false; sent.add(key); return true; },
    async deleteUser(uid) {
      users.delete(+uid);
      for (const k of [...kv.keys()]) if (k.startsWith(uid + "|")) kv.delete(k);
      for (const k of [...rems.keys()]) if (k.startsWith(uid + "|")) rems.delete(k);
      for (const [k, m] of [...members]) if (m.uid === +uid) members.delete(k);
      for (const [k, m] of [...marks]) if (m.uid === +uid) marks.delete(k);
    },
    async health() { return "memory"; },
  };
}

function ydbDb() {
  const { Driver, MetadataAuthService, TypedValues, ExecuteQuerySettings, OperationParams, AUTO_TX } = require("ydb-sdk");
  // YDB_ENDPOINT можно вставить целиком из консоли: grpcs://ydb.serverless.yandexcloud.net:2135/?database=/ru-central1/...
  let endpoint = (process.env.YDB_ENDPOINT || "").trim(), database = (process.env.YDB_DATABASE || "").trim();
  if (endpoint.includes("?database=")) { const [e, d] = endpoint.split("?database="); endpoint = e.replace(/\/+$/, ""); database = database || decodeURIComponent(d); }
  const driver = new Driver({
    endpoint,
    database,
    authService: new MetadataAuthService(),
  });
  let ready = null;
  const q = async (text, params) => {
    if (!ready) ready = driver.ready(10000).then(ok => { if (!ok) { ready = null; throw new Error("YDB не подключилась"); } });
    await ready;
    return driver.tableClient.withSession(async s => {
      const st = new ExecuteQuerySettings().withKeepInCache(true).withOperationParams(new OperationParams().withOperationTimeoutSeconds(45).withCancelAfterSeconds(45));
      const res = await s.executeQuery(text, params || {}, AUTO_TX, st);
      return (res.resultSets || []).map(rows);
    });
  };
  const val = v => {
    if (!v) return null;
    if (v.textValue != null) return v.textValue;
    if (v.uint64Value != null) return Number(String(v.uint64Value));
    if (v.int64Value != null) return Number(String(v.int64Value));
    if (v.int32Value != null) return v.int32Value;
    if (v.uint32Value != null) return v.uint32Value;
    return null;
  };
  const rows = rs => (rs.rows || []).map(r => { const o = {}; rs.columns.forEach((c, i) => o[c.name] = val(r.items[i])); return o; });
  const T = TypedValues;
  return {
    async getUser(id) {
      const [r] = await q(`DECLARE $id AS Uint64; SELECT * FROM users WHERE id = $id;`, { $id: T.uint64(+id) });
      return r && r[0] ? r[0] : null;
    },
    async putUser(u) {
      const decl = FIELDS.map(f => `DECLARE $${f} AS Utf8;`).join(" ");
      const p = { $id: T.uint64(+u.id) }; FIELDS.forEach(f => p["$" + f] = T.utf8(String(u[f] ?? "")));
      await q(`DECLARE $id AS Uint64; ${decl} UPSERT INTO users (id, ${FIELDS.join(", ")}) VALUES ($id, ${FIELDS.map(f => "$" + f).join(", ")});`, p);
    },
    async listUsers() {
      let out = [], last = 0;
      for (let i = 0; i < 100; i++) {
        const [r] = await q(`DECLARE $last AS Uint64; SELECT * FROM users WHERE id > $last ORDER BY id LIMIT 900;`, { $last: T.uint64(last) });
        if (!r || !r.length) break; out = out.concat(r); last = r[r.length - 1].id; if (r.length < 900) break;
      }
      return out;
    },
    async clubJoin(ch, uid, name) {
      await q(`DECLARE $ch AS Utf8; DECLARE $uid AS Uint64; DECLARE $name AS Utf8; UPSERT INTO club_members (ch, uid, name) VALUES ($ch, $uid, $name);`,
        { $ch: T.utf8(ch), $uid: T.uint64(+uid), $name: T.utf8(name || "") });
    },
    async clubPatch(ch, uid, fn) { return fn({}); }, // в YDB подарки и аватарки не хранятся (по умолчанию используется Object Storage)
    async clubRaw(ch) { return (await this.clubMembers(ch)).map(m => ({ ...m })); },
    async clubMembers(ch) {
      let out = [], last = 0;
      for (let i = 0; i < 100; i++) {
        const [r] = await q(`DECLARE $ch AS Utf8; DECLARE $last AS Uint64; SELECT ch, uid, name FROM club_members WHERE ch = $ch AND uid > $last ORDER BY uid LIMIT 900;`, { $ch: T.utf8(ch), $last: T.uint64(last) });
        if (!r || !r.length) break; out = out.concat(r); last = r[r.length - 1].uid; if (r.length < 900) break;
      }
      return out;
    },
    async clubMark(ch, day, uid, v) {
      const p = { $ch: T.utf8(ch), $day: T.utf8(day), $uid: T.uint64(+uid) };
      if (v == null) await q(`DECLARE $ch AS Utf8; DECLARE $day AS Utf8; DECLARE $uid AS Uint64; DELETE FROM club_marks WHERE ch = $ch AND day = $day AND uid = $uid;`, p);
      else await q(`DECLARE $ch AS Utf8; DECLARE $day AS Utf8; DECLARE $uid AS Uint64; DECLARE $v AS Int32; UPSERT INTO club_marks (ch, day, uid, v) VALUES ($ch, $day, $uid, $v);`, { ...p, $v: T.int32(+v) });
    },
    async clubDayMarks(ch, day) {
      const [r] = await q(`DECLARE $ch AS Utf8; DECLARE $day AS Utf8; SELECT uid, v FROM club_marks WHERE ch = $ch AND day = $day LIMIT 5000;`, { $ch: T.utf8(ch), $day: T.utf8(day) });
      return r || [];
    },
    async clubStats(ch, day) {
      const [cnt, td, bd] = await q(`DECLARE $ch AS Utf8; DECLARE $day AS Utf8;
        SELECT COUNT(*) AS n FROM club_members WHERE ch = $ch;
        SELECT m.uid AS uid, c.name AS name FROM club_marks AS m LEFT JOIN club_members AS c ON c.ch = m.ch AND c.uid = m.uid WHERE m.ch = $ch AND m.day = $day AND m.v = 1 LIMIT 200;
        SELECT c.uid AS uid, c.name AS name, COUNT(m.uid) AS n FROM club_members AS c LEFT JOIN (SELECT * FROM club_marks WHERE ch = $ch AND v = 1) AS m ON m.uid = c.uid WHERE c.ch = $ch GROUP BY c.uid, c.name ORDER BY n DESC LIMIT 1000;`,
        { $ch: T.utf8(ch), $day: T.utf8(day) });
      return { members: (cnt && cnt[0] && cnt[0].n) || 0, today: (td || []).length, names: (td || []).map(r => r.name).filter(Boolean), board: (bd || []).filter(r => r.name).map(r => ({ uid: r.uid, name: r.name, n: Number(r.n) || 0 })) };
    },
    async kvAll(uid) {
      const o = {}; let last = "";
      for (let i = 0; i < 50; i++) {
        const [r] = await q(`DECLARE $uid AS Uint64; DECLARE $last AS Utf8; SELECT k, v FROM kv WHERE uid = $uid AND k > $last ORDER BY k LIMIT 900;`, { $uid: T.uint64(+uid), $last: T.utf8(last) });
        if (!r || !r.length) break; r.forEach(x => o[x.k] = x.v); last = r[r.length - 1].k; if (r.length < 900) break;
      }
      return o;
    },
    async kvPut(uid, put, del) {
      const ents = Object.entries(put || {}); const dels = del || [];
      for (let i = 0; i < ents.length; i += 40) {
        const part = ents.slice(i, i + 40); const p = { $uid: T.uint64(+uid) }; let decl = "DECLARE $uid AS Uint64; ", vals = [];
        part.forEach(([k, v], j) => { decl += `DECLARE $k${j} AS Utf8; DECLARE $v${j} AS Utf8; `; p["$k" + j] = T.utf8(k); p["$v" + j] = T.utf8(String(v)); vals.push(`($uid, $k${j}, $v${j})`); });
        await q(`${decl} UPSERT INTO kv (uid, k, v) VALUES ${vals.join(", ")};`, p);
      }
      for (let i = 0; i < dels.length; i += 40) {
        const part = dels.slice(i, i + 40); const p = { $uid: T.uint64(+uid) }; let decl = "DECLARE $uid AS Uint64; ";
        part.forEach((k, j) => { decl += `DECLARE $k${j} AS Utf8; `; p["$k" + j] = T.utf8(k); });
        await q(`${decl} DELETE FROM kv WHERE uid = $uid AND k IN (${part.map((_, j) => "$k" + j).join(", ")});`, p);
      }
    },
    async remSet(uid, list) {
      await q(`DECLARE $uid AS Uint64; DELETE FROM reminders WHERE uid = $uid;`, { $uid: T.uint64(+uid) });
      for (let i = 0; i < list.length; i += 30) {
        const part = list.slice(i, i + 30); const p = { $uid: T.uint64(+uid) }; let decl = "DECLARE $uid AS Uint64; ", vals = [];
        part.forEach((r, j) => { decl += `DECLARE $i${j} AS Utf8; DECLARE $a${j} AS Uint64; DECLARE $t${j} AS Utf8; `; p["$i" + j] = T.utf8(r.id); p["$a" + j] = T.uint64(r.at); p["$t" + j] = T.utf8(r.text); vals.push(`($uid, $i${j}, $a${j}, $t${j})`); });
        await q(`${decl} UPSERT INTO reminders (uid, id, at, text) VALUES ${vals.join(", ")};`, p);
      }
    },
    async remDue(now) {
      const [r] = await q(`DECLARE $now AS Uint64; SELECT uid, id, at, text FROM reminders VIEW idx_at WHERE at <= $now LIMIT 2000;`, { $now: T.uint64(now) });
      return r || [];
    },
    async remDel(list) {
      for (const r of list) await q(`DECLARE $uid AS Uint64; DECLARE $id AS Utf8; DELETE FROM reminders WHERE uid = $uid AND id = $id;`, { $uid: T.uint64(+r.uid), $id: T.utf8(r.id) });
    },
    async once(key) {
      const [r] = await q(`DECLARE $k AS Utf8; SELECT k FROM sent WHERE k = $k;`, { $k: T.utf8(key) });
      if (r && r.length) return false;
      await q(`DECLARE $k AS Utf8; UPSERT INTO sent (k) VALUES ($k);`, { $k: T.utf8(key) });
      return true;
    },
    async deleteUser(uid) {
      const p = { $uid: T.uint64(+uid) };
      await q(`DECLARE $uid AS Uint64;
        DELETE FROM kv WHERE uid = $uid;
        DELETE FROM reminders WHERE uid = $uid;
        DELETE FROM club_members WHERE uid = $uid;
        DELETE FROM club_marks WHERE uid = $uid;
        DELETE FROM users WHERE id = $uid;`, p);
    },
    async health() { const [r] = await q(`SELECT COUNT(*) AS n FROM users;`); return "ydb ok, пользователей: " + ((r && r[0] && r[0].n) || 0); },
  };
}


// ---------- Object Storage (Yandex Cloud, Россия): простые JSON-файлы в бакете ----------
let S3_TOKEN = "";
const setS3Token = t => { if (t) S3_TOKEN = t; };
let s3Fetch = (url, opts) => fetch(url, opts);
const setS3Fetch = f => { s3Fetch = f; };
function s3Db(bucket) {
  const base = "https://storage.yandexcloud.net/" + bucket + "/";
  const enc = k => k.split("/").map(encodeURIComponent).join("/");
  const hdr = extra => Object.assign({ "X-YaCloud-SubjectToken": S3_TOKEN }, extra || {});
  async function get(key) {
    const r = await s3Fetch(base + enc(key), { headers: hdr() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("Хранилище: " + r.status + " при чтении " + key);
    try { return JSON.parse(await r.text()); } catch (e) { return null; }
  }
  async function put(key, obj) {
    const r = await s3Fetch(base + enc(key), { method: "PUT", headers: hdr({ "Content-Type": "application/json" }), body: JSON.stringify(obj) });
    if (!r.ok) throw new Error("Хранилище: " + r.status + " при записи " + key);
  }
  async function del(key) { const r = await s3Fetch(base + enc(key), { method: "DELETE", headers: hdr() }); if (!r.ok && r.status !== 404) throw new Error("Хранилище: " + r.status + " при удалении " + key); }
  async function list(prefix) {
    const out = []; let token = "";
    for (let i = 0; i < 200; i++) {
      const q = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" }); if (token) q.set("continuation-token", token);
      const r = await s3Fetch(base + "?" + q.toString(), { headers: hdr() });
      if (!r.ok) throw new Error("Хранилище: " + r.status + " при списке " + prefix);
      const x = await r.text();
      for (const m of x.matchAll(/<Key>([^<]*)<\/Key>/g)) out.push(m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'"));
      const t = x.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/); if (!t || !/<IsTruncated>true/.test(x)) break; token = t[1];
    }
    return out;
  }
  async function pmap(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j]); } })); return out; }
  const chk = ch => "club/" + encodeURIComponent(ch) + "/";
  return {
    async getUser(id) { return await get(`u/${+id}.json`); },
    async putUser(u) { await put(`u/${+u.id}.json`, { ...u, id: +u.id }); },
    async listUsers() { const ks = (await list("u/")).filter(k => k.endsWith(".json")); return (await pmap(ks, 16, get)).filter(Boolean); },
    async clubJoin(ch, uid, name) { const k = chk(ch) + uid + ".json"; const m = (await get(k)) || { uid: +uid, marks: {} }; m.name = name || m.name || ""; m.uid = +uid; await put(k, m); },
    async clubMembers(ch) { const ks = await list(chk(ch)); return (await pmap(ks, 16, get)).filter(Boolean).map(m => ({ ch, uid: +m.uid, name: m.name || "" })); },
    async clubPatch(ch, uid, fn) { const k = chk(ch) + uid + ".json"; const m = (await get(k)) || { uid: +uid, name: "", marks: {} }; const r = fn(m); m.uid = +uid; await put(k, m); return r; },
    async clubRaw(ch) { return (await pmap(await list(chk(ch)), 16, get)).filter(Boolean); },
    async clubMark(ch, day, uid, v) { const k = chk(ch) + uid + ".json"; const m = (await get(k)) || { uid: +uid, name: "", marks: {} }; m.marks = m.marks || {}; m.times = m.times || {}; if (v == null) { delete m.marks[day]; delete m.times[day]; } else { m.marks[day] = v; if (v === 1) m.times[day] = Date.now(); } await put(k, m); },
    async clubDayMarks(ch, day) { const ks = await list(chk(ch)); return (await pmap(ks, 16, get)).filter(m => m && m.marks && m.marks[day] != null).map(m => ({ uid: +m.uid, v: m.marks[day] })); },
    async clubStats(ch, day) {
      const ms = (await pmap(await list(chk(ch)), 16, get)).filter(Boolean);
      const today = ms.filter(m => m.marks && m.marks[day] === 1);
      const ex = m => ({ av: m.av || "", gr: m.gr || 0, g: Object.values(m.gg || {}).reduce((a, l) => a + l.length, 0) });
      const board = ms.map(m => Object.assign({ uid: +m.uid, name: m.name || "", n: Object.values(m.marks || {}).filter(v => v === 1).length }, ex(m))).filter(b => b.name).sort((a, b) => b.n - a.n);
      const feed = today.filter(m => m.name).map(m => Object.assign({ uid: +m.uid, name: m.name, at: (m.times || {})[day] || 0 }, ex(m))).sort((a, b) => b.at - a.at);
      return { members: ms.length, today: today.length, names: today.map(m => m.name).filter(Boolean), board, feed };
    },
    async kvAll(uid) { return (await get(`kv/${+uid}.json`)) || {}; },
    async kvPut(uid, putObj, dels) { const k = `kv/${+uid}.json`; const o = (await get(k)) || {}; Object.assign(o, putObj || {}); for (const d of dels || []) delete o[d]; await put(k, o); },
    async remAdd(uid, r) { const l = ((await get(`rem/${+uid}.json`)) || []).filter(x => x.id !== r.id).concat(r); await this.remSet(uid, l); },
    async remSet(uid, l) {
      const idx = (await get("rem/_index.json")) || {};
      if (l.length) { await put(`rem/${+uid}.json`, l); idx[uid] = Math.min(...l.map(r => r.at)); } else { await del(`rem/${+uid}.json`); delete idx[uid]; }
      await put("rem/_index.json", idx);
    },
    async remDue(now) {
      const idx = (await get("rem/_index.json")) || {}; const out = [];
      for (const [uid, at] of Object.entries(idx)) { if (at > now) continue; const l = (await get(`rem/${uid}.json`)) || []; l.filter(r => r.at <= now).forEach(r => out.push({ uid: +uid, ...r })); }
      return out;
    },
    async remDel(items) {
      const idx = (await get("rem/_index.json")) || {}; const by = {};
      items.forEach(r => (by[r.uid] = by[r.uid] || new Set()).add(r.id));
      for (const [uid, ids] of Object.entries(by)) {
        const l = ((await get(`rem/${uid}.json`)) || []).filter(r => !ids.has(r.id));
        if (l.length) { await put(`rem/${uid}.json`, l); idx[uid] = Math.min(...l.map(r => r.at)); } else { await del(`rem/${uid}.json`); delete idx[uid]; }
      }
      await put("rem/_index.json", idx);
    },
    async once(key) { const k = "sent/" + require("crypto").createHash("sha1").update(key).digest("hex") + ".json"; if (await get(k)) return false; await put(k, { key, at: Date.now() }); return true; },
    async deleteUser(uid) {
      await del(`u/${+uid}.json`); await del(`kv/${+uid}.json`);
      const idx = (await get("rem/_index.json")) || {}; if (idx[uid] != null) { delete idx[uid]; await put("rem/_index.json", idx); } await del(`rem/${+uid}.json`);
      for (const k of (await list("club/")).filter(k => k.endsWith("/" + (+uid) + ".json"))) await del(k);
    },
    async health() { const n = (await list("u/")).length; return "хранилище ok, пользователей: " + n; },
  };
}

module.exports = { memoryDb, ydbDb, s3Db, setS3Token, setS3Fetch };
