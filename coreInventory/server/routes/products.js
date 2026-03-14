// server/routes/products.js
// GET    /api/products              – list all products (with stock totals)
// GET    /api/products/:id          – single product + stock per location
// POST   /api/products              – create product
// PUT    /api/products/:id          – update product
// DELETE /api/products/:id          – delete (only if no stock moves)
// GET    /api/products/categories   – list categories
// POST   /api/products/categories   – create category

const router = require("express").Router();
const db     = require("../db");
const auth   = require("../middleware/auth");

router.use(auth);

// ── GET /api/products/categories ─────────────────────────────────────────
router.get("/categories", (req, res) => {
  const cats = db.prepare("SELECT * FROM product_categories ORDER BY name").all();
  res.json(cats);
});

// ── POST /api/products/categories ────────────────────────────────────────
router.post("/categories", (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name is required." });
  const r = db.prepare("INSERT OR IGNORE INTO product_categories (name) VALUES (?)").run(name);
  const cat = db.prepare("SELECT * FROM product_categories WHERE id = ?").get(r.lastInsertRowid);
  res.status(201).json(cat);
});

// ── GET /api/products ────────────────────────────────────────────────────
router.get("/", (req, res) => {
  const { search, category_id, low_stock } = req.query;

  let sql = `
    SELECT
      p.*,
      pc.name AS category_name,
      COALESCE(SUM(s.quantity), 0) AS total_stock,
      CASE WHEN COALESCE(SUM(s.quantity), 0) = 0 THEN 'out_of_stock'
           WHEN COALESCE(SUM(s.quantity), 0) <= p.reorder_level THEN 'low_stock'
           ELSE 'in_stock'
      END AS stock_status
    FROM products p
    LEFT JOIN product_categories pc ON pc.id = p.category_id
    LEFT JOIN stock s ON s.product_id = p.id
    WHERE 1=1
  `;
  const params = [];

  if (search) {
    sql += " AND (p.name LIKE ? OR p.sku LIKE ?)";
    params.push(`%${search}%`, `%${search}%`);
  }
  if (category_id) {
    sql += " AND p.category_id = ?";
    params.push(category_id);
  }
  sql += " GROUP BY p.id ORDER BY p.name";

  let rows = db.prepare(sql).all(...params);

  if (low_stock === "true") {
    rows = rows.filter(r => r.stock_status !== "in_stock");
  }

  res.json(rows);
});

// ── GET /api/products/:id ────────────────────────────────────────────────
router.get("/:id", (req, res) => {
  const product = db
    .prepare(`
      SELECT p.*, pc.name AS category_name
      FROM products p
      LEFT JOIN product_categories pc ON pc.id = p.category_id
      WHERE p.id = ?
    `)
    .get(req.params.id);

  if (!product) return res.status(404).json({ error: "Product not found." });

  // Stock per location
  const stockByLocation = db
    .prepare(`
      SELECT s.quantity, l.id AS location_id, l.name AS location_name,
             w.id AS warehouse_id, w.name AS warehouse_name
      FROM stock s
      JOIN locations l ON l.id = s.location_id
      JOIN warehouses w ON w.id = l.warehouse_id
      WHERE s.product_id = ?
    `)
    .all(req.params.id);

  res.json({ ...product, stock: stockByLocation });
});

// ── POST /api/products ───────────────────────────────────────────────────
router.post("/", (req, res) => {
  const { name, sku, category_id, unit_of_measure, reorder_level, initial_stock, location_id } = req.body;
  if (!name || !sku) return res.status(400).json({ error: "name and sku are required." });

  const existing = db.prepare("SELECT id FROM products WHERE sku = ?").get(sku);
  if (existing) return res.status(409).json({ error: "SKU already exists." });

  const insertProduct = db.prepare(`
    INSERT INTO products (name, sku, category_id, unit_of_measure, reorder_level)
    VALUES (?, ?, ?, ?, ?)
  `);

  const upsertStock = db.prepare(`
    INSERT INTO stock (product_id, location_id, quantity)
    VALUES (?, ?, ?)
    ON CONFLICT(product_id, location_id) DO UPDATE SET quantity = quantity + excluded.quantity
  `);

  const createProduct = db.transaction(() => {
    const r = insertProduct.run(
      name,
      sku,
      category_id || null,
      unit_of_measure || "unit",
      reorder_level || 0
    );
    const productId = r.lastInsertRowid;

    if (initial_stock && initial_stock > 0 && location_id) {
      upsertStock.run(productId, location_id, initial_stock);
    }

    return db.prepare("SELECT * FROM products WHERE id = ?").get(productId);
  });

  const product = createProduct();
  res.status(201).json(product);
});

// ── PUT /api/products/:id ────────────────────────────────────────────────
router.put("/:id", (req, res) => {
  const { name, sku, category_id, unit_of_measure, reorder_level } = req.body;
  const existing = db.prepare("SELECT id FROM products WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Product not found." });

  db.prepare(`
    UPDATE products
    SET name = COALESCE(?, name),
        sku  = COALESCE(?, sku),
        category_id = COALESCE(?, category_id),
        unit_of_measure = COALESCE(?, unit_of_measure),
        reorder_level = COALESCE(?, reorder_level)
    WHERE id = ?
  `).run(name, sku, category_id, unit_of_measure, reorder_level, req.params.id);

  res.json(db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id));
});

// ── DELETE /api/products/:id ─────────────────────────────────────────────
router.delete("/:id", (req, res) => {
  const moves = db.prepare("SELECT id FROM stock_moves WHERE product_id = ? LIMIT 1").get(req.params.id);
  if (moves) return res.status(400).json({ error: "Cannot delete product with stock history." });

  db.prepare("DELETE FROM products WHERE id = ?").run(req.params.id);
  res.json({ message: "Product deleted." });
});

module.exports = router;
