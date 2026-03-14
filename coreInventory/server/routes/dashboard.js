// server/routes/dashboard.js
// GET /api/dashboard  – all KPIs in one shot

const router = require("express").Router();
const db     = require("../db");
const auth   = require("../middleware/auth");

router.use(auth);

router.get("/", (req, res) => {
  // Total unique products with any stock
  const totalProducts = db
    .prepare("SELECT COUNT(DISTINCT id) AS count FROM products")
    .get().count;

  // Low stock: total_stock > 0 AND total_stock <= reorder_level
  const lowStock = db
    .prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT p.id
        FROM products p
        LEFT JOIN stock s ON s.product_id = p.id
        GROUP BY p.id
        HAVING COALESCE(SUM(s.quantity), 0) > 0
           AND COALESCE(SUM(s.quantity), 0) <= p.reorder_level
      )
    `)
    .get().count;

  // Out of stock: total_stock = 0
  const outOfStock = db
    .prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT p.id
        FROM products p
        LEFT JOIN stock s ON s.product_id = p.id
        GROUP BY p.id
        HAVING COALESCE(SUM(s.quantity), 0) = 0
      )
    `)
    .get().count;

  // Pending receipts (not done/cancelled)
  const pendingReceipts = db
    .prepare("SELECT COUNT(*) AS count FROM receipts WHERE status NOT IN ('done','cancelled')")
    .get().count;

  // Pending deliveries
  const pendingDeliveries = db
    .prepare("SELECT COUNT(*) AS count FROM deliveries WHERE status NOT IN ('done','cancelled')")
    .get().count;

  // Scheduled internal transfers
  const scheduledTransfers = db
    .prepare("SELECT COUNT(*) AS count FROM internal_transfers WHERE status NOT IN ('done','cancelled')")
    .get().count;

  // Recent receipts (last 5)
  const recentReceipts = db
    .prepare("SELECT id, reference, supplier_name, status, created_at FROM receipts ORDER BY created_at DESC LIMIT 5")
    .all();

  // Recent deliveries (last 5)
  const recentDeliveries = db
    .prepare("SELECT id, reference, customer_name, status, created_at FROM deliveries ORDER BY created_at DESC LIMIT 5")
    .all();

  // Low stock product list
  const lowStockProducts = db
    .prepare(`
      SELECT p.id, p.name, p.sku, p.unit_of_measure, p.reorder_level,
             COALESCE(SUM(s.quantity), 0) AS total_stock
      FROM products p
      LEFT JOIN stock s ON s.product_id = p.id
      GROUP BY p.id
      HAVING total_stock <= p.reorder_level
      ORDER BY total_stock ASC
      LIMIT 10
    `)
    .all();

  res.json({
    kpis: {
      totalProducts,
      lowStock,
      outOfStock,
      pendingReceipts,
      pendingDeliveries,
      scheduledTransfers,
    },
    recentReceipts,
    recentDeliveries,
    lowStockProducts,
  });
});

module.exports = router;
