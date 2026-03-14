// server/routes/deliveries.js
// GET    /api/deliveries
// GET    /api/deliveries/:id
// POST   /api/deliveries
// PUT    /api/deliveries/:id
// POST   /api/deliveries/:id/validate  → decreases stock + logs moves
// POST   /api/deliveries/:id/cancel

const router = require("express").Router();
const db     = require("../db");
const auth   = require("../middleware/auth");

router.use(auth);

function nextReference() {
  const year  = new Date().getFullYear();
  const count = db.prepare("SELECT COUNT(*) as c FROM deliveries").get().c + 1;
  return `DEL/${year}/${String(count).padStart(4, "0")}`;
}

// ── GET /api/deliveries ──────────────────────────────────────────────────
router.get("/", (req, res) => {
  const { status, from_date, to_date, search } = req.query;
  let sql = `
    SELECT d.*, u.name AS created_by_name
    FROM deliveries d
    JOIN users u ON u.id = d.created_by
    WHERE 1=1
  `;
  const params = [];
  if (status)    { sql += " AND d.status = ?"; params.push(status); }
  if (from_date) { sql += " AND d.scheduled_date >= ?"; params.push(from_date); }
  if (to_date)   { sql += " AND d.scheduled_date <= ?"; params.push(to_date); }
  if (search)    { sql += " AND (d.reference LIKE ? OR d.customer_name LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }
  sql += " ORDER BY d.created_at DESC";
  res.json(db.prepare(sql).all(...params));
});

// ── GET /api/deliveries/:id ──────────────────────────────────────────────
router.get("/:id", (req, res) => {
  const delivery = db
    .prepare(`SELECT d.*, u.name AS created_by_name, l.name AS location_name
              FROM deliveries d
              JOIN users u ON u.id = d.created_by
              LEFT JOIN locations l ON l.id = d.location_id
              WHERE d.id = ?`)
    .get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found." });

  const lines = db
    .prepare(`SELECT dl.*, p.name AS product_name, p.sku, p.unit_of_measure
              FROM delivery_lines dl
              JOIN products p ON p.id = dl.product_id
              WHERE dl.delivery_id = ?`)
    .all(req.params.id);

  res.json({ ...delivery, lines });
});

// ── POST /api/deliveries ─────────────────────────────────────────────────
router.post("/", (req, res) => {
  const { customer_name, scheduled_date, location_id, notes, lines } = req.body;
  if (!location_id) return res.status(400).json({ error: "location_id is required." });
  if (!lines || !lines.length) return res.status(400).json({ error: "At least one line is required." });

  const reference = nextReference();

  const create = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO deliveries (reference, customer_name, scheduled_date, location_id, notes, created_by)
      VALUES (?,?,?,?,?,?)
    `).run(reference, customer_name || null, scheduled_date || null, location_id, notes || null, req.user.id);

    const deliveryId = r.lastInsertRowid;
    const insertLine = db.prepare("INSERT INTO delivery_lines (delivery_id, product_id, qty) VALUES (?,?,?)");
    for (const line of lines) {
      insertLine.run(deliveryId, line.product_id, line.qty || 0);
    }
    return deliveryId;
  });

  const deliveryId = create();
  res.status(201).json(db.prepare("SELECT * FROM deliveries WHERE id = ?").get(deliveryId));
});

// ── PUT /api/deliveries/:id ──────────────────────────────────────────────
router.put("/:id", (req, res) => {
  const delivery = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found." });
  if (["done", "cancelled"].includes(delivery.status))
    return res.status(400).json({ error: `Cannot edit a ${delivery.status} delivery.` });

  const { customer_name, scheduled_date, location_id, notes, status, lines } = req.body;

  db.prepare(`
    UPDATE deliveries SET
      customer_name  = COALESCE(?, customer_name),
      scheduled_date = COALESCE(?, scheduled_date),
      location_id    = COALESCE(?, location_id),
      notes          = COALESCE(?, notes),
      status         = COALESCE(?, status)
    WHERE id = ?
  `).run(customer_name, scheduled_date, location_id, notes, status, req.params.id);

  if (lines && lines.length) {
    db.prepare("DELETE FROM delivery_lines WHERE delivery_id = ?").run(req.params.id);
    const insertLine = db.prepare("INSERT INTO delivery_lines (delivery_id, product_id, qty) VALUES (?,?,?)");
    for (const line of lines) insertLine.run(req.params.id, line.product_id, line.qty || 0);
  }

  res.json(db.prepare("SELECT * FROM deliveries WHERE id = ?").get(req.params.id));
});

// ── POST /api/deliveries/:id/validate ────────────────────────────────────
// Decreases stock. Checks for sufficient stock before proceeding.
router.post("/:id/validate", (req, res) => {
  const delivery = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found." });
  if (delivery.status === "done") return res.status(400).json({ error: "Delivery already validated." });
  if (delivery.status === "cancelled") return res.status(400).json({ error: "Cannot validate a cancelled delivery." });

  const lines = db.prepare("SELECT * FROM delivery_lines WHERE delivery_id = ?").all(req.params.id);
  if (!lines.length) return res.status(400).json({ error: "No lines to validate." });

  // Pre-check stock sufficiency
  const insufficient = [];
  for (const line of lines) {
    const stock = db
      .prepare("SELECT quantity FROM stock WHERE product_id = ? AND location_id = ?")
      .get(line.product_id, delivery.location_id);
    if (!stock || stock.quantity < line.qty) {
      const p = db.prepare("SELECT name FROM products WHERE id = ?").get(line.product_id);
      insufficient.push({ product: p?.name, available: stock?.quantity || 0, required: line.qty });
    }
  }
  if (insufficient.length) {
    return res.status(400).json({ error: "Insufficient stock.", details: insufficient });
  }

  const decreaseStock = db.prepare(`
    UPDATE stock SET quantity = quantity - ? WHERE product_id = ? AND location_id = ?
  `);
  const insertMove = db.prepare(`
    INSERT INTO stock_moves (product_id, from_location_id, to_location_id, qty, reference_type, reference_id, created_by)
    VALUES (?,?,NULL,?,?,?,?)
  `);

  const validate = db.transaction(() => {
    for (const line of lines) {
      decreaseStock.run(line.qty, line.product_id, delivery.location_id);
      insertMove.run(line.product_id, delivery.location_id, line.qty, "delivery", delivery.id, req.user.id);
    }
    db.prepare("UPDATE deliveries SET status = 'done', validated_at = datetime('now') WHERE id = ?").run(delivery.id);
  });

  validate();
  res.json({ message: "Delivery validated. Stock updated." });
});

// ── POST /api/deliveries/:id/cancel ──────────────────────────────────────
router.post("/:id/cancel", (req, res) => {
  const delivery = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery not found." });
  if (delivery.status === "done") return res.status(400).json({ error: "Cannot cancel a validated delivery." });

  db.prepare("UPDATE deliveries SET status = 'cancelled' WHERE id = ?").run(req.params.id);
  res.json({ message: "Delivery cancelled." });
});

module.exports = router;
