// server/routes/receipts.js
// GET    /api/receipts          – list (filterable by status, date)
// GET    /api/receipts/:id      – single receipt with lines
// POST   /api/receipts          – create receipt (draft)
// PUT    /api/receipts/:id      – update header/lines (only if not done/cancelled)
// POST   /api/receipts/:id/validate – validate → increases stock + logs moves
// POST   /api/receipts/:id/cancel   – cancel receipt

const router = require("express").Router();
const db     = require("../db");
const auth   = require("../middleware/auth");

router.use(auth);

// ── reference generator ──────────────────────────────────────────────────
function nextReference(prefix) {
  const year = new Date().getFullYear();
  const table = prefix === "REC" ? "receipts" : prefix === "DEL" ? "deliveries" : "internal_transfers";
  const count = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get().c + 1;
  return `${prefix}/${year}/${String(count).padStart(4, "0")}`;
}

// ── GET /api/receipts ────────────────────────────────────────────────────
router.get("/", (req, res) => {
  const { status, from_date, to_date, search } = req.query;
  let sql = `
    SELECT r.*, u.name AS created_by_name
    FROM receipts r
    JOIN users u ON u.id = r.created_by
    WHERE 1=1
  `;
  const params = [];

  if (status)    { sql += " AND r.status = ?";                params.push(status); }
  if (from_date) { sql += " AND r.scheduled_date >= ?";       params.push(from_date); }
  if (to_date)   { sql += " AND r.scheduled_date <= ?";       params.push(to_date); }
  if (search)    { sql += " AND (r.reference LIKE ? OR r.supplier_name LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }

  sql += " ORDER BY r.created_at DESC";
  res.json(db.prepare(sql).all(...params));
});

// ── GET /api/receipts/:id ────────────────────────────────────────────────
router.get("/:id", (req, res) => {
  const receipt = db
    .prepare(`SELECT r.*, u.name AS created_by_name, l.name AS location_name
              FROM receipts r
              JOIN users u ON u.id = r.created_by
              LEFT JOIN locations l ON l.id = r.location_id
              WHERE r.id = ?`)
    .get(req.params.id);

  if (!receipt) return res.status(404).json({ error: "Receipt not found." });

  const lines = db
    .prepare(`SELECT rl.*, p.name AS product_name, p.sku, p.unit_of_measure
              FROM receipt_lines rl
              JOIN products p ON p.id = rl.product_id
              WHERE rl.receipt_id = ?`)
    .all(req.params.id);

  res.json({ ...receipt, lines });
});

// ── POST /api/receipts ───────────────────────────────────────────────────
router.post("/", (req, res) => {
  const { supplier_name, scheduled_date, location_id, notes, lines } = req.body;
  if (!location_id) return res.status(400).json({ error: "location_id is required." });
  if (!lines || !lines.length) return res.status(400).json({ error: "At least one line is required." });

  const reference = nextReference("REC");

  const insertReceipt = db.prepare(`
    INSERT INTO receipts (reference, supplier_name, scheduled_date, location_id, notes, created_by)
    VALUES (?,?,?,?,?,?)
  `);
  const insertLine = db.prepare(`
    INSERT INTO receipt_lines (receipt_id, product_id, expected_qty, received_qty)
    VALUES (?,?,?,?)
  `);

  const create = db.transaction(() => {
    const r = insertReceipt.run(reference, supplier_name || null, scheduled_date || null, location_id, notes || null, req.user.id);
    const receiptId = r.lastInsertRowid;
    for (const line of lines) {
      insertLine.run(receiptId, line.product_id, line.expected_qty || 0, line.received_qty || 0);
    }
    return receiptId;
  });

  const receiptId = create();
  res.status(201).json(db.prepare("SELECT * FROM receipts WHERE id = ?").get(receiptId));
});

// ── PUT /api/receipts/:id ────────────────────────────────────────────────
router.put("/:id", (req, res) => {
  const receipt = db.prepare("SELECT * FROM receipts WHERE id = ?").get(req.params.id);
  if (!receipt) return res.status(404).json({ error: "Receipt not found." });
  if (["done", "cancelled"].includes(receipt.status))
    return res.status(400).json({ error: `Cannot edit a ${receipt.status} receipt.` });

  const { supplier_name, scheduled_date, location_id, notes, status, lines } = req.body;

  db.prepare(`
    UPDATE receipts SET
      supplier_name  = COALESCE(?, supplier_name),
      scheduled_date = COALESCE(?, scheduled_date),
      location_id    = COALESCE(?, location_id),
      notes          = COALESCE(?, notes),
      status         = COALESCE(?, status)
    WHERE id = ?
  `).run(supplier_name, scheduled_date, location_id, notes, status, req.params.id);

  if (lines && lines.length) {
    db.prepare("DELETE FROM receipt_lines WHERE receipt_id = ?").run(req.params.id);
    const insertLine = db.prepare(`
      INSERT INTO receipt_lines (receipt_id, product_id, expected_qty, received_qty)
      VALUES (?,?,?,?)
    `);
    for (const line of lines) {
      insertLine.run(req.params.id, line.product_id, line.expected_qty || 0, line.received_qty || 0);
    }
  }

  res.json(db.prepare("SELECT * FROM receipts WHERE id = ?").get(req.params.id));
});

// ── POST /api/receipts/:id/validate ──────────────────────────────────────
// Increases stock for each line's received_qty and logs to stock_moves
router.post("/:id/validate", (req, res) => {
  const receipt = db.prepare("SELECT * FROM receipts WHERE id = ?").get(req.params.id);
  if (!receipt) return res.status(404).json({ error: "Receipt not found." });
  if (receipt.status === "done") return res.status(400).json({ error: "Receipt already validated." });
  if (receipt.status === "cancelled") return res.status(400).json({ error: "Cannot validate a cancelled receipt." });

  const lines = db.prepare("SELECT * FROM receipt_lines WHERE receipt_id = ?").all(req.params.id);
  if (!lines.length) return res.status(400).json({ error: "No lines to validate." });

  const upsertStock = db.prepare(`
    INSERT INTO stock (product_id, location_id, quantity) VALUES (?,?,?)
    ON CONFLICT(product_id, location_id) DO UPDATE SET quantity = quantity + excluded.quantity
  `);
  const insertMove = db.prepare(`
    INSERT INTO stock_moves (product_id, from_location_id, to_location_id, qty, reference_type, reference_id, created_by)
    VALUES (?,NULL,?,?,?,?,?)
  `);

  const validate = db.transaction(() => {
    for (const line of lines) {
      if (line.received_qty <= 0) continue;
      upsertStock.run(line.product_id, receipt.location_id, line.received_qty);
      insertMove.run(line.product_id, receipt.location_id, line.received_qty, "receipt", receipt.id, req.user.id);
    }
    db.prepare("UPDATE receipts SET status = 'done', validated_at = datetime('now') WHERE id = ?").run(receipt.id);
  });

  validate();
  res.json({ message: "Receipt validated. Stock updated." });
});

// ── POST /api/receipts/:id/cancel ────────────────────────────────────────
router.post("/:id/cancel", (req, res) => {
  const receipt = db.prepare("SELECT * FROM receipts WHERE id = ?").get(req.params.id);
  if (!receipt) return res.status(404).json({ error: "Receipt not found." });
  if (receipt.status === "done") return res.status(400).json({ error: "Cannot cancel a validated receipt." });

  db.prepare("UPDATE receipts SET status = 'cancelled' WHERE id = ?").run(req.params.id);
  res.json({ message: "Receipt cancelled." });
});

module.exports = router;
