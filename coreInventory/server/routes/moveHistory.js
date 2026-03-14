// server/routes/moveHistory.js
// GET /api/moves   – filterable stock ledger (all stock_moves)

const router = require("express").Router();
const db     = require("../db");
const auth   = require("../middleware/auth");

router.use(auth);

// ── GET /api/moves ───────────────────────────────────────────────────────
// Query params: product_id, reference_type, from_date, to_date, location_id
router.get("/", (req, res) => {
  const { product_id, reference_type, from_date, to_date, location_id, page = 1, limit = 50 } = req.query;

  let sql = `
    SELECT
      sm.*,
      p.name         AS product_name,
      p.sku          AS product_sku,
      p.unit_of_measure,
      fl.name        AS from_location_name,
      tl.name        AS to_location_name,
      u.name         AS created_by_name
    FROM stock_moves sm
    JOIN products p  ON p.id  = sm.product_id
    LEFT JOIN locations fl ON fl.id = sm.from_location_id
    LEFT JOIN locations tl ON tl.id = sm.to_location_id
    JOIN users u ON u.id = sm.created_by
    WHERE 1=1
  `;
  const params = [];

  if (product_id)     { sql += " AND sm.product_id = ?";        params.push(product_id); }
  if (reference_type) { sql += " AND sm.reference_type = ?";    params.push(reference_type); }
  if (from_date)      { sql += " AND sm.created_at >= ?";       params.push(from_date); }
  if (to_date)        { sql += " AND sm.created_at <= ?";       params.push(to_date); }
  if (location_id)    {
    sql += " AND (sm.from_location_id = ? OR sm.to_location_id = ?)";
    params.push(location_id, location_id);
  }

  sql += " ORDER BY sm.created_at DESC";

  // Pagination
  const offset = (Number(page) - 1) * Number(limit);
  const countSql = `SELECT COUNT(*) as total FROM (${sql})`;
  const total = db.prepare(countSql).get(...params).total;

  sql += " LIMIT ? OFFSET ?";
  params.push(Number(limit), offset);

  const rows = db.prepare(sql).all(...params);
  res.json({ total, page: Number(page), limit: Number(limit), data: rows });
});

module.exports = router;
