-- 比价项目 · 建表脚本
-- 价格一律用"分"（整数），避免浮点误差
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS product (
  id          INTEGER PRIMARY KEY,
  brand       TEXT,
  model       TEXT NOT NULL,
  storage     TEXT,
  color       TEXT,
  category    TEXT NOT NULL,
  title_zol   TEXT,
  image_url   TEXT,
  image_local TEXT,
  jd_sku      TEXT,               -- 从 ZOL 的京东联盟链接里提取的京东 SKU
  msrp        INTEGER,
  match_key   TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS listing (
  id          INTEGER PRIMARY KEY,
  product_id  INTEGER NOT NULL REFERENCES product(id),
  platform    TEXT NOT NULL,
  title_raw   TEXT NOT NULL,
  url         TEXT NOT NULL,
  price       INTEGER,
  currency    TEXT NOT NULL DEFAULT 'CNY',
  in_stock    INTEGER,
  seller      TEXT,
  seller_type TEXT,        -- official 自营/品牌旗舰 / third_party / second_hand
  condition   TEXT,        -- new / used / refurb
  region      TEXT,
  account_kind TEXT,
  coupon_scope TEXT,
  confidence  TEXT NOT NULL DEFAULT 'partial',  -- ok / partial
  captured_at TEXT NOT NULL,
  UNIQUE (product_id, platform, captured_at)
);

CREATE TABLE IF NOT EXISTS price_history (
  id          INTEGER PRIMARY KEY,
  product_id  INTEGER NOT NULL,
  platform    TEXT NOT NULL,
  price       INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  UNIQUE (product_id, platform, captured_at)
);

CREATE TABLE IF NOT EXISTS coupon (
  id           INTEGER PRIMARY KEY,
  platform     TEXT NOT NULL,
  product_id   INTEGER REFERENCES product(id),
  shop         TEXT,
  kind         TEXT NOT NULL,   -- cash / discount / shipping / member
  amount       INTEGER,
  rate         REAL,
  threshold    INTEGER NOT NULL DEFAULT 0,
  stackable    INTEGER NOT NULL DEFAULT 0,
  scope        TEXT,
  need_action  TEXT,
  buy_n        INTEGER,
  pay_channel  TEXT,
  valid_from   TEXT,
  valid_to     TEXT,
  captured_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS match_log (
  id                INTEGER PRIMARY KEY,
  listing_raw_title TEXT NOT NULL,
  product_id        INTEGER,
  confidence        REAL,
  method            TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS product_alias (
  id          INTEGER PRIMARY KEY,
  raw_title   TEXT NOT NULL UNIQUE,
  product_id  INTEGER,
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- 原始页面快照索引（文件放 data/raw/，库里只存路径与哈希）
CREATE TABLE IF NOT EXISTS snapshot_file (
  id          INTEGER PRIMARY KEY,
  url         TEXT NOT NULL,
  path        TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  captured_at TEXT NOT NULL
);

-- 每轮抓取报告
CREATE TABLE IF NOT EXISTS collect_run (
  id             INTEGER PRIMARY KEY,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  category       TEXT,
  requested      INTEGER NOT NULL DEFAULT 0,
  ok_count       INTEGER NOT NULL DEFAULT 0,
  fail_count     INTEGER NOT NULL DEFAULT 0,
  anomaly_count  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'running',  -- running / ok / partial / aborted
  note           TEXT
);
