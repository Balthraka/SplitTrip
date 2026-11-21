-- Tables the core reads and writes. Copy these into the app's first migration; the app adds its own tables after them.
-- Timestamps are ISO-8601 UTC text with 6 fractional digits (the core writes them with nowIso()).
-- The display-name column of `users` can be called anything (createApp's `naming.column`); it is `name` here.

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,          -- stored lowercase
  name        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE TABLE identities (
  provider    TEXT NOT NULL,                 -- 'google' | 'microsoft'
  subject     TEXT NOT NULL,                 -- the provider's stable `sub`
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX idx_identities_user ON identities(user_id);

CREATE TABLE sessions (
  token_hash     TEXT PRIMARY KEY,           -- SHA-256 hex of the bearer token; the token itself is never stored
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_email INTEGER NOT NULL DEFAULT 0, -- 1 only when the provider reported the email as verified (Google)
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
