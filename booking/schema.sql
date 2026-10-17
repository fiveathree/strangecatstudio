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
  created_at  TEXT NOT NULL,
  email       TEXT                           -- optional; confirmations are sent here
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
  description TEXT,                       -- longer text for the product's own page
  sale_price  INTEGER,                    -- lower price while on offer; NULL = not on offer
  gallery     TEXT,                       -- extra photos: comma-separated image ids
  options     TEXT,                       -- JSON: [{"name":"戒圍","values":["10","11"]}]
  created_at  TEXT NOT NULL
);

-- Uploaded product photos (resized in the browser before upload).
CREATE TABLE IF NOT EXISTS images (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  type  TEXT NOT NULL,
  data  BLOB NOT NULL
);

-- Shop orders. Prices and names are copied into order_items so an order still
-- reads correctly after the product is edited or deleted.
CREATE TABLE IF NOT EXISTS orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,
  email        TEXT,
  line_id      TEXT,
  ship_method  TEXT NOT NULL,              -- store | home | tn | kh (see SHOP in worker.js)
  ship_to      TEXT,                       -- store name or address
  note         TEXT,
  subtotal     INTEGER NOT NULL,
  discount     INTEGER NOT NULL DEFAULT 0, -- NT$ taken off by spending points
  points_used  INTEGER NOT NULL DEFAULT 0,
  points_earned INTEGER NOT NULL DEFAULT 0, -- given when the order was marked paid
  promo_code   TEXT,
  promo_discount INTEGER NOT NULL DEFAULT 0, -- NT$ taken off by the promo code
  ship_fee     INTEGER NOT NULL,
  total        INTEGER NOT NULL,
  -- pending | reported | paid | shipped | done | cancelled
  status       TEXT NOT NULL DEFAULT 'pending',
  pay_last5    TEXT,
  tracking     TEXT,                       -- parcel number, filled in by the studio
  admin_note   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_phone ON orders (phone);

CREATE TABLE IF NOT EXISTS order_items (
  order_id    INTEGER NOT NULL,
  product_id  INTEGER NOT NULL,
  name        TEXT NOT NULL,
  price       INTEGER NOT NULL,
  qty         INTEGER NOT NULL,
  options     TEXT                        -- chosen options, e.g. 戒圍:12、顏色:藍
);
CREATE INDEX IF NOT EXISTS order_items_order ON order_items (order_id);

-- One row per customer, keyed by phone; filled in from orders and bookings.
CREATE TABLE IF NOT EXISTS customers (
  phone       TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT,
  line_id     TEXT,
  note        TEXT,                        -- the studio's own notes
  tags        TEXT,                        -- comma-separated labels, e.g. VIP,寵物紀念
  birthday    TEXT,                        -- MM-DD
  marketing   INTEGER NOT NULL DEFAULT 0,  -- 1 = agreed to hear about new work and events
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Loyalty points ledger: a customer's balance is the sum of their rows.
CREATE TABLE IF NOT EXISTS points (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL,
  delta       INTEGER NOT NULL,            -- + earned or given, - spent or taken back
  reason      TEXT,
  order_id    INTEGER,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS points_phone ON points (phone);

-- How products are filed. kind 'stone' = what it is made of, 'cat' = what kind of piece.
-- Products store the slug, so a category can be renamed freely.
CREATE TABLE IF NOT EXISTS categories (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  kind  TEXT NOT NULL,
  slug  TEXT NOT NULL,
  name  TEXT NOT NULL,
  sort  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (kind, slug)
);
INSERT OR IGNORE INTO categories (kind, slug, name, sort) VALUES
  ('stone', 'glass', '玻璃鑽石', 10), ('stone', 'lab', '實驗室鑽石', 20), ('stone', 'cosmic', '宇宙玻璃', 30),
  ('stone', 'crystal', '水晶鍊', 40), ('stone', 'glassware', '玻璃飾品', 50),
  ('cat', 'ring', '戒指', 10), ('cat', 'necklace', '項鍊', 20), ('cat', 'earrings', '耳環', 30),
  ('cat', 'bracelet', '手鍊', 40), ('cat', 'other', '其他', 50);

-- Back-office accounts. The master password (the ADMIN_TOKEN secret) signs in as well; its 2FA record is settings 'master_mfa'.
CREATE TABLE IF NOT EXISTS staff (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,               -- owner | staff
  salt        TEXT NOT NULL,
  hash        TEXT NOT NULL,               -- PBKDF2 of the password; the password itself is never stored
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  mfa         TEXT                         -- 2FA: JSON { passkeys: [{ id, key, alg }], backup (hashes), challenge, exp }; NULL = not set up yet
);
-- Who is signed in. Only a hash of the session token is kept. staff_id 0 = the master password.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  staff_id    INTEGER NOT NULL,
  expires_at  TEXT NOT NULL
);
-- Every change made in the back office, and by whom.
CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id    INTEGER NOT NULL,
  staff_name  TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail      TEXT,
  created_at  TEXT NOT NULL
);
-- Counts requests per visitor so nobody can flood orders, bookings or password guesses.
CREATE TABLE IF NOT EXISTS rate_limits (
  key  TEXT NOT NULL,
  win  INTEGER NOT NULL,
  n    INTEGER NOT NULL,
  PRIMARY KEY (key, win)
);

-- Promo codes.
CREATE TABLE IF NOT EXISTS promos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  kind        TEXT NOT NULL,               -- percent | amount
  value       INTEGER NOT NULL,            -- % off, or NT$ off
  min_spend   INTEGER NOT NULL DEFAULT 0,
  max_uses    INTEGER,                     -- NULL = unlimited
  used        INTEGER NOT NULL DEFAULT 0,
  starts      TEXT,                        -- YYYY-MM-DD or empty
  ends        TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
