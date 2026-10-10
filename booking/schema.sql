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

-- Things the studio can change from the admin page.
--   notify_emails: comma-separated addresses that receive booking emails
CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

-- Shop catalogue, edited from the admin page.
CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  stone       TEXT NOT NULL,              -- glass | lab | cosmic | crystal | glassware
  cat         TEXT NOT NULL,              -- ring | necklace | earrings | bracelet | other
  supply      TEXT NOT NULL,              -- stock (ready to ship) | made (made to order)
  note        TEXT,                       -- one line of specs
  price       INTEGER,                    -- NT$; NULL = ask
  price_from  INTEGER NOT NULL DEFAULT 0, -- 1 shows the price as "起"
  stock       INTEGER,                    -- NULL = not counted
  status      TEXT NOT NULL DEFAULT 'active', -- active | soldout | hidden
  sort        INTEGER NOT NULL DEFAULT 0,
  link        TEXT,                       -- where the card goes; empty = booking page
  image_id    INTEGER,                    -- photo uploaded from the admin page
  image_url   TEXT,                       -- or a file already in the site's assets
  created_at  TEXT NOT NULL
);

-- Uploaded product photos (resized in the browser before upload).
CREATE TABLE IF NOT EXISTS images (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  type  TEXT NOT NULL,
  data  BLOB NOT NULL
);
