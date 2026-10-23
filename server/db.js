// Хранилище: YDB (в Yandex Cloud) или память (для локальных тестов).
const FIELDS = ["name", "username", "created", "trial", "paid", "seen", "rem"];

function memoryDb() {
  const users = new Map(), members = new Map(), marks = new Map();
  return {
    async getUser(id) { const u = users.get(+id); return u ? { ...u } : null; },
    async putUser(u) { users.set(+u.id, { ...u, id: +u.id }); },
    async listUsers() { return [...users.values()].map(u => ({ ...u })); },
    async clubJoin(ch, uid, name) { members.set(ch + "|" + uid, { ch, uid: +uid, name }); },
    async clubMark(ch, day, uid, v) { const k = ch + "|" + day + "|" + uid; if (v == null) marks.delete(k); else marks.set(k, { ch, day, uid: +uid, v }); },
    async clubStats(ch, day) {
      const ms = [...members.values()].filter(m => m.ch === ch);
      const today = [...marks.values()].filter(m => m.ch === ch && m.day === day && m.v === 1);
      const names = today.map(t => (ms.find(m => m.uid === t.uid) || {}).name || "").filter(Boolean);
      return { members: ms.length, today: today.length, names };
    },
    async health() { return "memory"; },
  };
}

function ydbDb() {
  const { Driver, MetadataAuthService, TypedValues } = require("ydb-sdk");
  const driver = new Driver({
    endpoint: process.env.YDB_ENDPOINT,
    database: process.env.YDB_DATABASE,
    authService: new MetadataAuthService(),
  });
  let ready = null;
  const q = async (text, params) => {
    if (!ready) ready = driver.ready(10000).then(ok => { if (!ok) { ready = null; throw new Error("YDB не подключилась"); } });
    await ready;
    return driver.tableClient.withSession(async s => {
      const res = await s.executeQuery(text, params || {});
      return (res.resultSets || []).map(rows);
    });
  };
  const val = v => {
    if (!v || v.nullFlagValue !== undefined && v.nullFlagValue !== null && v.textValue == null && v.uint64Value == null && v.int32Value == null && v.int64Value == null) return null;
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
    async clubMark(ch, day, uid, v) {
      const p = { $ch: T.utf8(ch), $day: T.utf8(day), $uid: T.uint64(+uid) };
      if (v == null) await q(`DECLARE $ch AS Utf8; DECLARE $day AS Utf8; DECLARE $uid AS Uint64; DELETE FROM club_marks WHERE ch = $ch AND day = $day AND uid = $uid;`, p);
      else await q(`DECLARE $ch AS Utf8; DECLARE $day AS Utf8; DECLARE $uid AS Uint64; DECLARE $v AS Int32; UPSERT INTO club_marks (ch, day, uid, v) VALUES ($ch, $day, $uid, $v);`, { ...p, $v: T.int32(+v) });
    },
    async clubStats(ch, day) {
      const [cnt, td] = await q(`DECLARE $ch AS Utf8; DECLARE $day AS Utf8;
        SELECT COUNT(*) AS n FROM club_members WHERE ch = $ch;
        SELECT m.uid AS uid, c.name AS name FROM club_marks AS m LEFT JOIN club_members AS c ON c.ch = m.ch AND c.uid = m.uid WHERE m.ch = $ch AND m.day = $day AND m.v = 1 LIMIT 200;`,
        { $ch: T.utf8(ch), $day: T.utf8(day) });
      return { members: (cnt && cnt[0] && cnt[0].n) || 0, today: (td || []).length, names: (td || []).map(r => r.name).filter(Boolean) };
    },
    async health() { const [r] = await q(`SELECT COUNT(*) AS n FROM users;`); return "ydb ok, пользователей: " + ((r && r[0] && r[0].n) || 0); },
  };
}

module.exports = { memoryDb, ydbDb };
