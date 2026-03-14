// server/routes/adjustments.js
// GET    /api/adjustments
// GET    /api/adjustments/:id
// POST   /api/adjustments
// PUT    /api/adjustments/:id
// POST   /api/adjustments/:id/validate  → updates stock to counted qty
// POST   /api/adjustments/:id/cancel

const router = require("express").Router();
const db     = require("../db");
const auth   = require("../middleware/auth");

router.use(auth);

function nextReference() {
  const year  = new Date().getFullYear();
  const count = db.prepare("SELECT COUNT(*) as c FROM stock_adjustments").get().c + 1;
  return `ADJ/${year}/${String(count).padStart(4, "0")}`;
}

// ── GET /api/adjustments ─────────────────────────────────────────────────
router.get("/", (req, res) => {
  const { status } = req.query;
  let sql = `
    SELECT a.*, l.name AS location_name, w.name AS warehouse_name, u.name AS created_by_name
    FROM stock_adjustments a
    JOIN locations l ON l.id = a.location_id
    JOIN warehouses w ON w.id = l.warehouse_id
    JOIN users u ON u.id = a.created_by
    WHERE 1=1
  `;
  const params = [];
  if (status) { sql += " AND a.status = ?"; params.push(status); }
  sql += " ORDER BY a.created_at DESC";
  res.json(db.prepare(sql).all(...params));
});

// ── GET /api/adjustments/:id ─────────────────────────────────────────────
router.get("/:id", (req, res) => {
  const adj = db
    .prepare(`SELECT a.*, l.name AS location_name, u.name AS created_by_name
              FROM stock_adjustments a
              JOIN locations l ON l.id = a.location_id
              JOIN users u ON u.id = a.created_by
              WHERE a.id = ?`)
    .get(req.params.id);
  if (!adj) return res.status(404).json({ error: "Adjustment not found." });

  const lines = db
    .prepare(`SELECT al.*, p.name AS product_name, p.sku, p.unit_of_measure
              FROM adjustment_lines al
              JOIN products p ON p.id = al.product_id
              WHERE al.adjustment_id = ?`)
    .all(req.params.id);

  res.json({ ...adj, lines });
});

// ── POST /api/adjustments ────────────────────────────────────────────────
// Lines: [{ product_id, counted_qty }]
// recorded_qty is pulled automatically from current stock.
router.post("/", (req, res) => {
  const { location_id, notes, lines } = req.body;
  if (!location_id) return res.status(400).json({ error: "location_id is required." });
  if (!lines || !lines.length) return res.status(400).json({ error: "At least one line is required." });

  const reference = nextReference();

  const create = db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO stock_adjustments (reference, location_id, notes, created_by)
      VALUES (?,?,?,?)
    `).run(reference, location_id, notes || null, req.user.id);

    const adjId = r.lastInsertRowid;
    const insertLine = db.prepare(`
      INSERT INTO adjustment_lines (adjustment_id, product_id, recorded_qty, counted_qty)
      VALUES (?,?,?,?)
    `);

    for (const line of lines) {
      const stockRow = db
        .prepare("SELECT quantity FROM stock WHERE product_id = ? AND location_id = ?")
        .get(line.product_id, location_id);
      const recorded = stockRow ? stockRow.quantity : 0;
      insertLine.run(adjId, line.product_id, recorded, line.counted_qty ?? recorded);
    }
    return adjId;
  });

  const adjId = create();
  res.status(201).json(db.prepare("SELECT * FROM stock_adjustments WHERE id = ?").get(adjId));
});

// ── PUT /api/adjustments/:id ─────────────────────────────────────────────
router.put("/:id", (req, res) => {
  const adj = db.prepare("SELECT * FROM stock_adjustments WHERE id = ?").get(req.params.id);
  if (!adj) return res.status(404).json({ error: "Adjustment not found." });
  if (adj.status !== "draft") return res.status(400).json({ error: "Can only edit draft adjustments." });

  const { notes, lines } = req.body;
  if (notes !== undefined)
    db.prepare("UPDATE stock_adjustments SET notes = ? WHERE id = ?").run(notes, req.params.id);

  if (lines && lines.length) {
    db.prepare("DELETE FROM adjustment_lines WHERE adjustment_id = ?").run(req.params.id);
    const insertLine = db.prepare(`
      INSERT INTO adjustment_lines (adjustment_id, product_id, recorded_qty, counted_qty)
      VALUES (?,?,?,?)
    `);
    for (const line of lines) {
      const stockRow = db
        .prepare("SELECT quantity FROM stock WHERE product_id = ? AND location_id = ?")
        .get(line.product_id, adj.location_id);
      const recorded = stockRow ? stockRow.quantity : 0;
      insertLine.run(req.params.id, line.product_id, recorded, line.counted_qty ?? recorded);
    }
  }

  res.json(db.prepare("SELECT * FROM stock_adjustments WHERE id = ?").get(req.params.id));
});

// ── POST /api/adjustments/:id/validate ───────────────────────────────────
// Sets stock to counted_qty for each line. Logs positive/negative moves.
router.post("/:id/validate", (req, res) => {
  const adj = db.prepare("SELECT * FROM stock_adjustments WHERE id = ?").get(req.params.id);
  if (!adj) return res.status(404).json({ error: "Adjustment not found." });
  if (adj.status === "done") return res.status(400).json({ error: "Adjustment already validated." });
  if (adj.status === "cancelled") return res.status(400).json({ error: "Cannot validate a cancelled adjustment." });

  const lines = db.prepare("SELECT * FROM adjustment_lines WHERE adjustment_id = ?").all(req.params.id);
  if (!lines.length) return res.status(400).json({ error: "No lines to validate." });

  const upsertStock = db.prepare(`
    INSERT INTO stock (product_id, location_id, quantity) VALUES (?,?,?)
    ON CONFLICT(product_id, location_id) DO UPDATE SET quantity = excluded.quantity
  `);
  const insertMove = db.prepare(`
    INSERT INTO stock_moves
      (product_id, from_location_id, to_location_id, qty, reference_type, reference_id, created_by)
    VALUES (?,?,?,?,?,?,?)
  `);

  const validate = db.transaction(() => {
    for (const line of lines) {
      const diff = line.counted_qty - line.recorded_qty;
      // Set stock to the physically counted quantity
      upsertStock.run(line.product_id, adj.location_id, line.counted_qty);
      // Log the net movement (positive = gain, negative = loss)
      if (diff !== 0) {
        const from = diff < 0 ? adj.location_id : null;
        const to   = diff > 0 ? adj.location_id : null;
        insertMove.run(line.product_id, from, to, Math.abs(diff), "adjustment", adj.id, req.user.id);
      }
    }
    db.prepare("UPDATE stock_adjustments SET status = 'done', validated_at = datetime('now') WHERE id = ?").run(adj.id);
  });

  validate();
  res.json({ message: "Adjustment validated. Stock corrected." });
});

// ── POST /api/adjustments/:id/cancel ─────────────────────────────────────
router.post("/:id/cancel", (req, res) => {
  const adj = db.prepare("SELECT * FROM stock_adjustments WHERE id = ?").get(req.params.id);
  if (!adj) return res.status(404).json({ error: "Adjustment not found." });
  if (adj.status === "done") return res.status(400).json({ error: "Cannot cancel a validated adjustment." });

  db.prepare("UPDATE stock_adjustments SET status = 'cancelled' WHERE id = ?").run(req.params.id);
  res.json({ message: "Adjustment cancelled." });
});

module.exports = router;
