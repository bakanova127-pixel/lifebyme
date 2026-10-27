-- Вставь это целиком в YDB → «Навигация» → «Новый SQL-запрос» → «Выполнить»
CREATE TABLE users (
  id Uint64, name Utf8, username Utf8, created Utf8, trial Utf8, paid Utf8, seen Utf8, rem Utf8, consent Utf8,
  PRIMARY KEY (id)
);
CREATE TABLE club_members (
  ch Utf8, uid Uint64, name Utf8,
  PRIMARY KEY (ch, uid)
);
CREATE TABLE club_marks (
  ch Utf8, day Utf8, uid Uint64, v Int32,
  PRIMARY KEY (ch, day, uid)
);
CREATE TABLE kv (
  uid Uint64, k Utf8, v Utf8,
  PRIMARY KEY (uid, k)
);
CREATE TABLE reminders (
  uid Uint64, id Utf8, at Uint64, text Utf8,
  PRIMARY KEY (uid, id),
  INDEX idx_at GLOBAL ON (at)
);
CREATE TABLE sent (
  k Utf8,
  PRIMARY KEY (k)
);
