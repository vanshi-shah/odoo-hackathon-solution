// server/routes/transfers.js
// GET    /api/transfers
// GET    /api/transfers/:id
// POST   /api/transfers
// PUT    /api/transfers/:id
// POST   /api/transfers/:id/validate  → moves stock between locations
// POST   /api/transfers/:id/cancel

const router = require("express").Router();
const db     = require("../db");
const auth   = require("../middleware/auth");

router.use(auth);

function nextReference() {
  const year  = new Date().getFullYear();
  const count = db.prepare("SELECT COUNT(*) as c FROM internal_transfers").get().c + 1;
  return `INT/${year}/${String(count).padStart(4, "0")}`;
}

// ── GET /api/transfers ───────────────────────────────────────────────────
router.get("/", (req, res) => {
  const { status, search } = req.query;
  let sql = `
    SELECT t.*,
           fl.name AS from_location_name, fw.name AS from_warehouse_name,
           tl.name AS to_location_name,   tw.name AS to_warehouse_name,
           u.name  AS created_by_name
    FROM internal_transfers t
    JOIN locations fl ON fl.id = t.from_location_id
    JOIN locations tl ON tl.id = t.to_location_id
    JOIN warehouses fw ON fw.id = fl.warehouse_id
    JOIN warehouses tw ON tw.id = tl.warehouse_id
    JOIN users u ON u.id = t.created_by
    WHERE 1=1
  `;
  const params = [];
  if (status) { sql += " AND t.status = ?"; params.push(status); }
  if (search) { sql += " AND t.reference LIKE ?"; params.push(`%${search}%`); }
  sql += " ORDER BY t.created_at DESC";
  res.json(db.prepare(sql).all(...params));
});

// ── GET /api/transfers/:id ───────────────────────────────────────────────
router.get("/:id", (req, res) => {
  const transfer = db
    .prepare(`
      SELECT t.*,
             fl.name AS from_location_name, fw.name AS from_warehouse_name,
             tl.name AS to_location_name,   tw.name AS to_warehouse_name,
             u.name  AS created_by_name
      FROM internal_transfers t
      JOIN locations fl ON fl.id = t.from_location_id
      JOIN locations tl ON tl.id = t.to_location_id
      JOIN warehouses fw ON fw.id = fl.warehouse_id
      JOIN warehouses tw ON tw.id = tl.warehouse_id
      JOIN users u ON u.id = t.created_by
      WHERE t.id = ?
    `)
    .get(req.params.id);
  if (!transfer) return res.status(404).json({ error: "Transfer not found." });

  const lines = db
    .prepare(`SELECT tl.*, p.name AS product_name, p.sku, p.unit_of_measure
              FROM transfer_lines tl
              JOIN products p ON p.id = tl.product_id
              WHERE tl.transfer_id = ?`)
    .all(req.params.id);

  res.json({ ...transfer, lines });
});

// ── POST /api/transfers ──────────────────────────────────────────────────
router.post("/", (req, res) => {
  const { from_location_id, to_location_id, scheduled_date, notes, lines } = req.body;
  if (!from_location_id || !to_location_id)
    return res.status(400).json({ error: "from_location_id and to_location_id are required." });
  if (from_location_id === to_location_id)
    return res.status(400).json({ error: "Source and destination locations must differ." });
  if (!lines || !lines.length)
    return res.status(400).json({ error: "At least one line is required." });

  const reference = nextReference();

  const create = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO internal_transfers (reference, from_location_id, to_location_id, scheduled_date, notes, created_by)
      VALUES (?,?,?,?,?,?)
    `).run(reference, from_location_id, to_location_id, scheduled_date || null, notes || null, req.user.id);

    const transferId = r.lastInsertRowid;
    const insertLine = db.prepare("INSERT INTO transfer_lines (transfer_id, product_id, qty) VALUES (?,?,?)");
    for (const line of lines) insertLine.run(transferId, line.product_id, line.qty || 0);
    return transferId;
  });

  const transferId = create();
  res.status(201).json(db.prepare("SELECT * FROM internal_transfers WHERE id = ?").get(transferId));
});

// ── PUT /api/transfers/:id ───────────────────────────────────────────────
router.put("/:id", (req, res) => {
  const transfer = db.prepare("SELECT * FROM internal_transfers WHERE id = ?").get(req.params.id);
  if (!transfer) return res.status(404).json({ error: "Transfer not found." });
  if (["done", "cancelled"].includes(transfer.status))
    return res.status(400).json({ error: `Cannot edit a ${transfer.status} transfer.` });

  const { from_location_id, to_location_id, scheduled_date, notes, status, lines } = req.body;

  db.prepare(`
    UPDATE internal_transfers SET
      from_location_id = COALESCE(?, from_location_id),
      to_location_id   = COALESCE(?, to_location_id),
      scheduled_date   = COALESCE(?, scheduled_date),
      notes            = COALESCE(?, notes),
      status           = COALESCE(?, status)
    WHERE id = ?
  `).run(from_location_id, to_location_id, scheduled_date, notes, status, req.params.id);

  if (lines && lines.length) {
    db.prepare("DELETE FROM transfer_lines WHERE transfer_id = ?").run(req.params.id);
    const insertLine = db.prepare("INSERT INTO transfer_lines (transfer_id, product_id, qty) VALUES (?,?,?)");
    for (const line of lines) insertLine.run(req.params.id, line.product_id, line.qty || 0);
  }

  res.json(db.prepare("SELECT * FROM internal_transfers WHERE id = ?").get(req.params.id));
});

// ── POST /api/transfers/:id/validate ─────────────────────────────────────
// Deducts stock from source location, adds to destination. Total unchanged.
router.post("/:id/validate", (req, res) => {
  const transfer = db.prepare("SELECT * FROM internal_transfers WHERE id = ?").get(req.params.id);
  if (!transfer) return res.status(404).json({ error: "Transfer not found." });
  if (transfer.status === "done") return res.status(400).json({ error: "Transfer already validated." });
  if (transfer.status === "cancelled") return res.status(400).json({ error: "Cannot validate a cancelled transfer." });

  const lines = db.prepare("SELECT * FROM transfer_lines WHERE transfer_id = ?").all(req.params.id);
  if (!lines.length) return res.status(400).json({ error: "No lines to validate." });

  // Pre-check stock
  const insufficient = [];
  for (const line of lines) {
    const stock = db
      .prepare("SELECT quantity FROM stock WHERE product_id = ? AND location_id = ?")
      .get(line.product_id, transfer.from_location_id);
    if (!stock || stock.quantity < line.qty) {
      const p = db.prepare("SELECT name FROM products WHERE id = ?").get(line.product_id);
      insufficient.push({ product: p?.name, available: stock?.quantity || 0, required: line.qty });
    }
  }
  if (insufficient.length) return res.status(400).json({ error: "Insufficient stock.", details: insufficient });

  const decreaseStock = db.prepare(`
    UPDATE stock SET quantity = quantity - ? WHERE product_id = ? AND location_id = ?
  `);
  const upsertStock = db.prepare(`
    INSERT INTO stock (product_id, location_id, quantity) VALUES (?,?,?)
    ON CONFLICT(product_id, location_id) DO UPDATE SET quantity = quantity + excluded.quantity
  `);
  const insertMove = db.prepare(`
    INSERT INTO stock_moves (product_id, from_location_id, to_location_id, qty, reference_type, reference_id, created_by)
    VALUES (?,?,?,?,?,?,?)
  `);

  const validate = db.transaction(() => {
    for (const line of lines) {
      decreaseStock.run(line.qty, line.product_id, transfer.from_location_id);
      upsertStock.run(line.product_id, transfer.to_location_id, line.qty);
      insertMove.run(line.product_id, transfer.from_location_id, transfer.to_location_id, line.qty, "transfer", transfer.id, req.user.id);
    }
    db.prepare("UPDATE internal_transfers SET status = 'done', validated_at = datetime('now') WHERE id = ?").run(transfer.id);
  });

  validate();
  res.json({ message: "Transfer validated. Stock moved." });
});

// ── POST /api/transfers/:id/cancel ───────────────────────────────────────
router.post("/:id/cancel", (req, res) => {
  const transfer = db.prepare("SELECT * FROM internal_transfers WHERE id = ?").get(req.params.id);
  if (!transfer) return res.status(404).json({ error: "Transfer not found." });
  if (transfer.status === "done") return res.status(400).json({ error: "Cannot cancel a validated transfer." });

  db.prepare("UPDATE internal_transfers SET status = 'cancelled' WHERE id = ?").run(req.params.id);
  res.json({ message: "Transfer cancelled." });
});

module.exports = router;
