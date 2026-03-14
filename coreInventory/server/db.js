// server/db.js
const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "coreinventory.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    email       TEXT    NOT NULL UNIQUE,
    password    TEXT    NOT NULL,
    role        TEXT    NOT NULL DEFAULT 'staff' CHECK(role IN ('manager','staff')),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS otp_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    otp         TEXT    NOT NULL,
    expires_at  TEXT    NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS warehouses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    address     TEXT,
    coordinates TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS locations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    name         TEXT    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS product_categories (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT    NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS products (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    sku             TEXT    NOT NULL UNIQUE,
    category_id     INTEGER REFERENCES product_categories(id) ON DELETE SET NULL,
    unit_of_measure TEXT    NOT NULL DEFAULT 'unit',
    reorder_level   REAL    NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS stock (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL REFERENCES products(id)  ON DELETE CASCADE,
    location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    quantity    REAL    NOT NULL DEFAULT 0,
    UNIQUE(product_id, location_id)
  );
  CREATE TABLE IF NOT EXISTS receipts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    reference      TEXT    NOT NULL UNIQUE,
    supplier_name  TEXT,
    status         TEXT    NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','waiting','ready','done','cancelled')),
    scheduled_date TEXT,
    location_id    INTEGER REFERENCES locations(id),
    notes          TEXT,
    created_by     INTEGER NOT NULL REFERENCES users(id),
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    validated_at   TEXT
  );
  CREATE TABLE IF NOT EXISTS receipt_lines (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_id    INTEGER NOT NULL REFERENCES receipts(id)  ON DELETE CASCADE,
    product_id    INTEGER NOT NULL REFERENCES products(id)  ON DELETE RESTRICT,
    expected_qty  REAL    NOT NULL DEFAULT 0,
    received_qty  REAL    NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS deliveries (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    reference      TEXT    NOT NULL UNIQUE,
    customer_name  TEXT,
    status         TEXT    NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','waiting','ready','done','cancelled')),
    scheduled_date TEXT,
    location_id    INTEGER REFERENCES locations(id),
    notes          TEXT,
    created_by     INTEGER NOT NULL REFERENCES users(id),
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    validated_at   TEXT
  );
  CREATE TABLE IF NOT EXISTS delivery_lines (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id  INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
    product_id   INTEGER NOT NULL REFERENCES products(id)  ON DELETE RESTRICT,
    qty          REAL    NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS internal_transfers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    reference        TEXT    NOT NULL UNIQUE,
    from_location_id INTEGER NOT NULL REFERENCES locations(id),
    to_location_id   INTEGER NOT NULL REFERENCES locations(id),
    status           TEXT    NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','waiting','ready','done','cancelled')),
    scheduled_date   TEXT,
    notes            TEXT,
    created_by       INTEGER NOT NULL REFERENCES users(id),
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    validated_at     TEXT
  );
  CREATE TABLE IF NOT EXISTS transfer_lines (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_id  INTEGER NOT NULL REFERENCES internal_transfers(id) ON DELETE CASCADE,
    product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    qty          REAL    NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS stock_adjustments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    reference   TEXT    NOT NULL UNIQUE,
    location_id INTEGER NOT NULL REFERENCES locations(id),
    status      TEXT    NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','done','cancelled')),
    notes       TEXT,
    created_by  INTEGER NOT NULL REFERENCES users(id),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    validated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS adjustment_lines (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    adjustment_id   INTEGER NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
    product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    recorded_qty    REAL    NOT NULL DEFAULT 0,
    counted_qty     REAL    NOT NULL DEFAULT 0,
    difference      REAL    GENERATED ALWAYS AS (counted_qty - recorded_qty) VIRTUAL
  );
  CREATE TABLE IF NOT EXISTS stock_moves (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id       INTEGER NOT NULL REFERENCES products(id),
    from_location_id INTEGER REFERENCES locations(id),
    to_location_id   INTEGER REFERENCES locations(id),
    qty              REAL    NOT NULL,
    reference_type   TEXT    NOT NULL,
    reference_id     INTEGER NOT NULL,
    created_by       INTEGER NOT NULL REFERENCES users(id),
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );
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
//  SEED SAMPLE DATA — runs only on first launch
// ─────────────────────────────────────────────
const alreadySeeded = db.prepare("SELECT COUNT(*) as c FROM users").get().c > 0;

if (!alreadySeeded) {
  const bcrypt = require("bcryptjs");

  // Warehouses
  db.prepare("INSERT INTO warehouses (id,name,address,coordinates) VALUES (?,?,?,?)").run(1,'Main Warehouse','Plot 12, Industrial Zone, Ahmedabad','23.0225,72.5714');
  db.prepare("INSERT INTO warehouses (id,name,address,coordinates) VALUES (?,?,?,?)").run(2,'Secondary Warehouse','Sector 5, GIDC, Gandhinagar','23.2156,72.6369');

  // Locations
  db.prepare("INSERT INTO locations (id,warehouse_id,name) VALUES (?,?,?)").run(1,1,'Main Store');
  db.prepare("INSERT INTO locations (id,warehouse_id,name) VALUES (?,?,?)").run(2,1,'Rack A');
  db.prepare("INSERT INTO locations (id,warehouse_id,name) VALUES (?,?,?)").run(3,1,'Rack B');
  db.prepare("INSERT INTO locations (id,warehouse_id,name) VALUES (?,?,?)").run(4,1,'Production Floor');
  db.prepare("INSERT INTO locations (id,warehouse_id,name) VALUES (?,?,?)").run(5,2,'Store Room');
  db.prepare("INSERT INTO locations (id,warehouse_id,name) VALUES (?,?,?)").run(6,2,'Dispatch Bay');

  // Categories
  db.prepare("INSERT INTO product_categories (id,name) VALUES (?,?)").run(1,'Raw Materials');
  db.prepare("INSERT INTO product_categories (id,name) VALUES (?,?)").run(2,'Finished Goods');
  db.prepare("INSERT INTO product_categories (id,name) VALUES (?,?)").run(3,'Packaging');
  db.prepare("INSERT INTO product_categories (id,name) VALUES (?,?)").run(4,'Consumables');
  db.prepare("INSERT INTO product_categories (id,name) VALUES (?,?)").run(5,'Spare Parts');

  // Products
  const ip = db.prepare("INSERT INTO products (id,name,sku,category_id,unit_of_measure,reorder_level) VALUES (?,?,?,?,?,?)");
  ip.run(1, 'Steel Rods (10mm)',    'RM-001', 1, 'kg',  200);
  ip.run(2, 'Aluminium Sheets',     'RM-002', 1, 'kg',  150);
  ip.run(3, 'Industrial Bearings',  'SP-001', 5, 'pcs',  50);
  ip.run(4, 'Hydraulic Oil',        'CN-001', 4, 'ltr',  30);
  ip.run(5, 'Gear Assembly Unit',   'FG-001', 2, 'pcs',  20);
  ip.run(6, 'Control Panel Box',    'FG-002', 2, 'pcs',  10);
  ip.run(7, 'Cardboard Boxes (L)',  'PK-001', 3, 'pcs', 100);
  ip.run(8, 'Bubble Wrap Roll',     'PK-002', 3, 'mtr',  50);
  ip.run(9, 'Copper Wire (2.5mm)', 'RM-003', 1, 'mtr', 300);
  ip.run(10,'Safety Gloves',        'CN-002', 4, 'pcs',  40);

  // Stock
  const is = db.prepare("INSERT INTO stock (product_id,location_id,quantity) VALUES (?,?,?)");
  is.run(1,1,850); is.run(1,4,90);
  is.run(2,1,420); is.run(2,2,80);
  is.run(3,2,120); is.run(3,5,35);
  is.run(4,1,18);  // LOW STOCK
  is.run(5,1,45);  is.run(5,6,12);
  is.run(6,1,8);   // LOW STOCK
  is.run(7,1,340); is.run(7,6,60);
  is.run(8,3,180);
  is.run(9,1,620);
  is.run(10,1,0);  // OUT OF STOCK

  // Users
  const h1 = bcrypt.hashSync("admin123",10);
  const h2 = bcrypt.hashSync("staff123",10);
  const h3 = bcrypt.hashSync("manager123",10);
  db.prepare("INSERT INTO users (id,name,email,password,role) VALUES (?,?,?,?,?)").run(1,'Arjun Mehta',  'arjun@coreinventory.com',  h1,'manager');
  db.prepare("INSERT INTO users (id,name,email,password,role) VALUES (?,?,?,?,?)").run(2,'Priya Shah',   'priya@coreinventory.com',   h2,'staff');
  db.prepare("INSERT INTO users (id,name,email,password,role) VALUES (?,?,?,?,?)").run(3,'Rohan Desai',  'rohan@coreinventory.com',   h3,'manager');

  // Receipts
  const ir = db.prepare("INSERT INTO receipts (id,reference,supplier_name,status,scheduled_date,location_id,notes,created_by,created_at,validated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  ir.run(1,'REC/2025/0001','Tata Steel Ltd',       'done',    '2025-03-01',1,'Quarterly bulk steel order',        1,'2025-03-01 09:00:00','2025-03-01 11:30:00');
  ir.run(2,'REC/2025/0002','Hindalco Industries',  'done',    '2025-03-05',1,'Aluminium sheets restock',          1,'2025-03-04 10:00:00','2025-03-05 14:00:00');
  ir.run(3,'REC/2025/0003','SKF Bearings India',   'ready',   '2025-03-14',2,'Bearings for Q2 production run',    2,'2025-03-10 09:30:00',null);
  ir.run(4,'REC/2025/0004','Castrol Industrial',   'waiting', '2025-03-18',1,'Hydraulic oil urgent reorder',      1,'2025-03-12 11:00:00',null);
  ir.run(5,'REC/2025/0005','Polycab Wires',        'draft',   '2025-03-22',1,'Copper wire for new project',       3,'2025-03-13 15:00:00',null);

  const irl = db.prepare("INSERT INTO receipt_lines (receipt_id,product_id,expected_qty,received_qty) VALUES (?,?,?,?)");
  irl.run(1,1,500,500); irl.run(1,9,300,300);
  irl.run(2,2,200,200); irl.run(2,3,50,50);
  irl.run(3,3,80,0);
  irl.run(4,4,50,0);
  irl.run(5,9,400,0);

  // Deliveries
  const id2 = db.prepare("INSERT INTO deliveries (id,reference,customer_name,status,scheduled_date,location_id,notes,created_by,created_at,validated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  id2.run(1,'DEL/2025/0001','Bharat Engineering Co.', 'done',    '2025-03-03',1,'10 units Gear Assembly',           1,'2025-03-02 10:00:00','2025-03-03 13:00:00');
  id2.run(2,'DEL/2025/0002','Sunrise Electricals',    'done',    '2025-03-06',1,'Control panels and copper wire',   1,'2025-03-05 09:00:00','2025-03-06 16:00:00');
  id2.run(3,'DEL/2025/0003','Gujarat Infra Pvt Ltd',  'ready',   '2025-03-15',1,'Steel rods for construction site', 2,'2025-03-11 10:30:00',null);
  id2.run(4,'DEL/2025/0004','Mehta Fabricators',      'waiting', '2025-03-17',6,'Aluminium sheets and bearings',    1,'2025-03-12 14:00:00',null);
  id2.run(5,'DEL/2025/0005','National Motors Ltd',    'draft',   '2025-03-25',1,'Hydraulic components order',       3,'2025-03-13 16:00:00',null);

  const idl = db.prepare("INSERT INTO delivery_lines (delivery_id,product_id,qty) VALUES (?,?,?)");
  idl.run(1,5,10);
  idl.run(2,6,5); idl.run(2,9,100);
  idl.run(3,1,200);
  idl.run(4,2,80); idl.run(4,3,30);
  idl.run(5,4,10); idl.run(5,5,5);

  // Internal Transfers
  const it = db.prepare("INSERT INTO internal_transfers (id,reference,from_location_id,to_location_id,status,scheduled_date,notes,created_by,created_at,validated_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  it.run(1,'INT/2025/0001',1,4,'done',   '2025-03-02','Steel rods to production floor',     1,'2025-03-02 08:00:00','2025-03-02 09:00:00');
  it.run(2,'INT/2025/0002',1,2,'done',   '2025-03-07','Bearings to Rack A for picking',     2,'2025-03-06 14:00:00','2025-03-07 10:00:00');
  it.run(3,'INT/2025/0003',1,6,'ready',  '2025-03-14','Gear units to dispatch bay',         1,'2025-03-12 09:00:00',null);
  it.run(4,'INT/2025/0004',3,1,'waiting','2025-03-16','Bubble wrap return to main store',   2,'2025-03-13 11:00:00',null);
  it.run(5,'INT/2025/0005',1,5,'draft',  '2025-03-20','Secondary warehouse restock run',    3,'2025-03-13 15:00:00',null);

  const itl = db.prepare("INSERT INTO transfer_lines (transfer_id,product_id,qty) VALUES (?,?,?)");
  itl.run(1,1,90); itl.run(2,3,40); itl.run(3,5,12);
  itl.run(4,8,50); itl.run(5,2,100); itl.run(5,7,80);

  // Adjustments
  const ia = db.prepare("INSERT INTO stock_adjustments (id,reference,location_id,status,notes,created_by,created_at,validated_at) VALUES (?,?,?,?,?,?,?,?)");
  ia.run(1,'ADJ/2025/0001',1,'done',     'Monthly physical count - March week 2',    1,'2025-03-08 10:00:00','2025-03-08 16:00:00');
  ia.run(2,'ADJ/2025/0002',4,'done',     'Production floor spot check',              1,'2025-03-10 09:00:00','2025-03-10 11:00:00');
  ia.run(3,'ADJ/2025/0003',2,'draft',    'Rack A routine count',                     2,'2025-03-13 14:00:00',null);
  ia.run(4,'ADJ/2025/0004',1,'cancelled','Voided — duplicate entry',                 3,'2025-03-11 10:00:00',null);

  const ial = db.prepare("INSERT INTO adjustment_lines (adjustment_id,product_id,recorded_qty,counted_qty) VALUES (?,?,?,?)");
  ial.run(1,4,20,18); ial.run(1,10,5,0); ial.run(1,7,350,340);
  ial.run(2,1,95,90);
  ial.run(3,3,120,120); ial.run(3,2,85,80);

  // Stock moves ledger
  const im = db.prepare("INSERT INTO stock_moves (product_id,from_location_id,to_location_id,qty,reference_type,reference_id,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)");
  // Receipts
  im.run(1,null,1,500,'receipt',1,1,'2025-03-01 11:30:00');
  im.run(9,null,1,300,'receipt',1,1,'2025-03-01 11:30:00');
  im.run(2,null,1,200,'receipt',2,1,'2025-03-05 14:00:00');
  im.run(3,null,1,50, 'receipt',2,1,'2025-03-05 14:00:00');
  // Deliveries
  im.run(5,1,null,10, 'delivery',1,1,'2025-03-03 13:00:00');
  im.run(6,1,null,5,  'delivery',2,1,'2025-03-06 16:00:00');
  im.run(9,1,null,100,'delivery',2,1,'2025-03-06 16:00:00');
  // Transfers
  im.run(1,1,4,90,'transfer',1,1,'2025-03-02 09:00:00');
  im.run(3,1,2,40,'transfer',2,2,'2025-03-07 10:00:00');
  // Adjustments
  im.run(4, 1,null,2, 'adjustment',1,1,'2025-03-08 16:00:00');
  im.run(10,1,null,5, 'adjustment',1,1,'2025-03-08 16:00:00');
  im.run(7, 1,null,10,'adjustment',1,1,'2025-03-08 16:00:00');
  im.run(1, 4,null,5, 'adjustment',2,1,'2025-03-10 11:00:00');

  console.log("🌱  Sample data seeded — 3 users, 10 products, 5 receipts, 5 deliveries, 5 transfers, 4 adjustments.");
} else {
  console.log("⏭️   Seed skipped — data already exists.");
}

console.log("✅  Database ready →", DB_PATH);

module.exports = db;
