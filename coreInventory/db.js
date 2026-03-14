// server/db.js
// Initializes SQLite database and creates all tables on first run.

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "coreinventory.db");
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ─────────────────────────────────────────────
//  SCHEMA
// ─────────────────────────────────────────────
db.exec(`

  -- ── USERS ──────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    email       TEXT    NOT NULL UNIQUE,
    password    TEXT    NOT NULL,              -- bcrypt hash
    role        TEXT    NOT NULL DEFAULT 'staff'  -- 'manager' | 'staff'
                CHECK(role IN ('manager','staff')),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- ── OTP TOKENS (password reset) ─────────────────────────────────────
  CREATE TABLE IF NOT EXISTS otp_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    otp         TEXT    NOT NULL,
    expires_at  TEXT    NOT NULL,             -- ISO datetime
    used        INTEGER NOT NULL DEFAULT 0    -- 0 = false, 1 = true
  );

  -- ── WAREHOUSES ──────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS warehouses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    address     TEXT,
    coordinates TEXT,                         -- "lat,lng" string
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- ── LOCATIONS (racks / shelves inside a warehouse) ──────────────────
  CREATE TABLE IF NOT EXISTS locations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    name         TEXT    NOT NULL,            -- e.g. "Rack A", "Shelf 3"
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- ── PRODUCT CATEGORIES ──────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS product_categories (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT    NOT NULL UNIQUE
  );

  -- ── PRODUCTS ────────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS products (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    sku             TEXT    NOT NULL UNIQUE,
    category_id     INTEGER REFERENCES product_categories(id) ON DELETE SET NULL,
    unit_of_measure TEXT    NOT NULL DEFAULT 'unit',  -- e.g. kg, pcs, ltr
    reorder_level   REAL    NOT NULL DEFAULT 0,        -- alert threshold
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- ── STOCK (current qty per product per location) ─────────────────────
  -- One row per (product, location) pair. Updated on every validated move.
  CREATE TABLE IF NOT EXISTS stock (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    quantity    REAL    NOT NULL DEFAULT 0,
    UNIQUE(product_id, location_id)
  );

  -- ── RECEIPTS (incoming goods from vendor) ───────────────────────────
  CREATE TABLE IF NOT EXISTS receipts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    reference      TEXT    NOT NULL UNIQUE,  -- e.g. "REC/2025/0001"
    supplier_name  TEXT,
    status         TEXT    NOT NULL DEFAULT 'draft'
                   CHECK(status IN ('draft','waiting','ready','done','cancelled')),
    scheduled_date TEXT,
    location_id    INTEGER REFERENCES locations(id),  -- destination location
    notes          TEXT,
    created_by     INTEGER NOT NULL REFERENCES users(id),
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    validated_at   TEXT
  );

  -- ── RECEIPT LINES ────────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS receipt_lines (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id    INTEGER NOT NULL REFERENCES receipts(id)  ON DELETE CASCADE,
    product_id    INTEGER NOT NULL REFERENCES products(id)  ON DELETE RESTRICT,
    expected_qty  REAL    NOT NULL DEFAULT 0,
    received_qty  REAL    NOT NULL DEFAULT 0
  );

  -- ── DELIVERIES (outgoing goods to customer) ──────────────────────────
  CREATE TABLE IF NOT EXISTS deliveries (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    reference      TEXT    NOT NULL UNIQUE,  -- e.g. "DEL/2025/0001"
    customer_name  TEXT,
    status         TEXT    NOT NULL DEFAULT 'draft'
                   CHECK(status IN ('draft','waiting','ready','done','cancelled')),
    scheduled_date TEXT,
    location_id    INTEGER REFERENCES locations(id),  -- source location
    notes          TEXT,
    created_by     INTEGER NOT NULL REFERENCES users(id),
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    validated_at   TEXT
  );

  -- ── DELIVERY LINES ───────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS delivery_lines (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id  INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    product_id   INTEGER NOT NULL REFERENCES products(id)  ON DELETE RESTRICT,
    qty          REAL    NOT NULL DEFAULT 0
  );

  -- ── INTERNAL TRANSFERS ───────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS internal_transfers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    reference        TEXT    NOT NULL UNIQUE,  -- e.g. "INT/2025/0001"
    from_location_id INTEGER NOT NULL REFERENCES locations(id),
    to_location_id   INTEGER NOT NULL REFERENCES locations(id),
    status           TEXT    NOT NULL DEFAULT 'draft'
                     CHECK(status IN ('draft','waiting','ready','done','cancelled')),
    scheduled_date   TEXT,
    notes            TEXT,
    created_by       INTEGER NOT NULL REFERENCES users(id),
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    validated_at     TEXT
  );

  -- ── INTERNAL TRANSFER LINES ──────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS transfer_lines (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id  INTEGER NOT NULL REFERENCES internal_transfers(id) ON DELETE CASCADE,
    product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    qty          REAL    NOT NULL DEFAULT 0
  );

  -- ── STOCK ADJUSTMENTS ────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS stock_adjustments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reference   TEXT    NOT NULL UNIQUE,  -- e.g. "ADJ/2025/0001"
    location_id INTEGER NOT NULL REFERENCES locations(id),
    status      TEXT    NOT NULL DEFAULT 'draft'
                CHECK(status IN ('draft','done','cancelled')),
    notes       TEXT,
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    validated_at TEXT
  );

  -- ── ADJUSTMENT LINES ─────────────────────────────────────────────────
  CREATE TABLE IF NOT EXISTS adjustment_lines (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    adjustment_id   INTEGER NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
    product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    recorded_qty    REAL    NOT NULL DEFAULT 0,  -- qty before adjustment
    counted_qty     REAL    NOT NULL DEFAULT 0,  -- physically counted qty
    difference      REAL    GENERATED ALWAYS AS (counted_qty - recorded_qty) VIRTUAL
  );

  -- ── STOCK MOVES (master ledger — every stock change logged here) ─────
  -- reference_type: 'receipt' | 'delivery' | 'transfer' | 'adjustment'
  CREATE TABLE IF NOT EXISTS stock_moves (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id       INTEGER NOT NULL REFERENCES products(id),
    from_location_id INTEGER REFERENCES locations(id),   -- NULL = external source
    to_location_id   INTEGER REFERENCES locations(id),   -- NULL = external destination
    qty              REAL    NOT NULL,
    reference_type   TEXT    NOT NULL,
    reference_id     INTEGER NOT NULL,                    -- FK to the parent document
    created_by       INTEGER NOT NULL REFERENCES users(id),
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- ─────────────────────────────────────────────
  --  INDEXES  (for fast lookups on foreign keys)
  -- ─────────────────────────────────────────────
  CREATE INDEX IF NOT EXISTS idx_stock_product     ON stock(product_id);
  CREATE INDEX IF NOT EXISTS idx_stock_location    ON stock(location_id);
  CREATE INDEX IF NOT EXISTS idx_moves_product     ON stock_moves(product_id);
  CREATE INDEX IF NOT EXISTS idx_moves_ref         ON stock_moves(reference_type, reference_id);
  CREATE INDEX IF NOT EXISTS idx_receipt_lines     ON receipt_lines(receipt_id);
  CREATE INDEX IF NOT EXISTS idx_delivery_lines    ON delivery_lines(delivery_id);
  CREATE INDEX IF NOT EXISTS idx_transfer_lines    ON transfer_lines(transfer_id);
  CREATE INDEX IF NOT EXISTS idx_adjustment_lines  ON adjustment_lines(adjustment_id);

`);

// ─────────────────────────────────────────────
//  SEED: Default warehouse + location so the
//  app is usable right after first run.
// ─────────────────────────────────────────────
const seedWarehouse = db.prepare(
  "INSERT OR IGNORE INTO warehouses (id, name, address) VALUES (1, 'Main Warehouse', 'Default')"
);
const seedLocation = db.prepare(
  "INSERT OR IGNORE INTO locations (id, warehouse_id, name) VALUES (1, 1, 'Main Store')"
);
seedWarehouse.run();
seedLocation.run();

console.log("✅  Database ready →", DB_PATH);

module.exports = db;
