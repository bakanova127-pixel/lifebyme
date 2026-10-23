CREATE TABLE users (
  id Uint64, name Utf8, username Utf8, created Utf8, trial Utf8, paid Utf8, seen Utf8, rem Utf8,
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
