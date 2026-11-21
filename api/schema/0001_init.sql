-- SplitTrip D1 schema. Money is INTEGER minor units (amount * 100) in every currency.
-- Ids are the original Supabase UUIDs (kept on import). Timestamps are ISO-8601 UTC text with 6 fractional digits.

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

CREATE TABLE trips (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT,
  base_currency    TEXT NOT NULL,
  expense_currency TEXT NOT NULL,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL, -- as in Supabase; delete_my_account promotes another member first
  created_at       TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,            -- newest expense created_at, else trip created_at (replaces the old per-trip expense scan)
  version          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_trips_created_by ON trips(created_by);

CREATE TABLE trip_members (
  id          TEXT PRIMARY KEY,
  trip_id     TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  email       TEXT,                          -- lowercase, used by claim
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_members_trip_user ON trip_members(trip_id, user_id);
CREATE INDEX idx_members_user ON trip_members(user_id);
CREATE INDEX idx_members_email_unclaimed ON trip_members(email) WHERE user_id IS NULL;

CREATE TABLE expenses (
  id                TEXT PRIMARY KEY,
  trip_id           TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  paid_by_member_id TEXT NOT NULL REFERENCES trip_members(id) ON DELETE RESTRICT, -- old rule: a member who paid cannot be removed
  amount_cents      INTEGER NOT NULL CHECK (amount_cents > 0),
  currency          TEXT NOT NULL,
  date              TEXT NOT NULL,           -- YYYY-MM-DD
  description       TEXT NOT NULL,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  split_type        TEXT NOT NULL CHECK (split_type IN ('equal','percent','exact','single')),
  version           INTEGER NOT NULL DEFAULT 1,
  row_token         TEXT                     -- per-write nonce so the batch can tell "my update won" from "someone else's did"
);
CREATE INDEX idx_expenses_trip_date ON expenses(trip_id, date, created_at);
CREATE INDEX idx_expenses_trip_created ON expenses(trip_id, created_at);
CREATE INDEX idx_expenses_paid_by ON expenses(paid_by_member_id);
CREATE INDEX idx_expenses_created_by ON expenses(created_by);

CREATE TABLE expense_splits (
  id           TEXT PRIMARY KEY,
  expense_id   TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  trip_id      TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE, -- copy of the expense's trip, so loading a trip reads its splits without a join
  member_id    TEXT NOT NULL REFERENCES trip_members(id) ON DELETE CASCADE, -- old rule: removing a member removes their splits
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0)
);
CREATE INDEX idx_splits_expense ON expense_splits(expense_id);
CREATE INDEX idx_splits_member ON expense_splits(member_id);
CREATE INDEX idx_splits_trip ON expense_splits(trip_id);

CREATE TABLE payments (
  id             TEXT PRIMARY KEY,
  trip_id        TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  from_member_id TEXT NOT NULL REFERENCES trip_members(id) ON DELETE CASCADE,
  to_member_id   TEXT NOT NULL REFERENCES trip_members(id) ON DELETE CASCADE,
  amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
  currency       TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending','confirmed')),
  initiated_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  confirmed_at   TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  CHECK (from_member_id <> to_member_id)
);
CREATE INDEX idx_payments_trip ON payments(trip_id, created_at);
CREATE INDEX idx_payments_from ON payments(from_member_id);
CREATE INDEX idx_payments_to ON payments(to_member_id);
CREATE INDEX idx_payments_initiated_by ON payments(initiated_by);
CREATE INDEX idx_payments_confirmed_by ON payments(confirmed_by);
