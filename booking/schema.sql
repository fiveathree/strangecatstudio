-- 奇怪貓工作室 booking database (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS bookings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,          -- short reference the customer quotes
  studio      TEXT NOT NULL,                 -- 'tn' (台南) or 'kh' (高雄)
  date        TEXT NOT NULL,                 -- YYYY-MM-DD, Taipei time
  time        TEXT NOT NULL,                 -- HH:MM slot start
  type        TEXT NOT NULL,                 -- 'class' (體驗課) or 'visit' (到訪鑑賞)
  people      INTEGER NOT NULL,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL,
  line_id     TEXT,
  note        TEXT,
  -- pending   = class booked, waiting for the bank transfer
  -- reported  = customer sent the last five digits of the transfer
  -- confirmed = studio confirmed (visits start here: nothing to pay)
  -- cancelled = no longer holds a place
  status      TEXT NOT NULL DEFAULT 'pending',
  pay_last5   TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS bookings_slot ON bookings (studio, date, time);

-- Days a studio is closed (public holidays, days off).
CREATE TABLE IF NOT EXISTS closures (
  studio  TEXT NOT NULL,
  date    TEXT NOT NULL,
  reason  TEXT,
  PRIMARY KEY (studio, date)
);
