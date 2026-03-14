// server/routes/warehouses.js
// GET    /api/warehouses               – list all warehouses with their locations
// POST   /api/warehouses               – create warehouse
// PUT    /api/warehouses/:id           – update warehouse
// DELETE /api/warehouses/:id           – delete (if no stock)
// GET    /api/warehouses/:id/locations – list locations for a warehouse
// POST   /api/warehouses/:id/locations – add location to warehouse
// PUT    /api/warehouses/locations/:locId  – update location
// DELETE /api/warehouses/locations/:locId  – delete location

const router = require("express").Router();
const db     = require("../db");
const auth   = require("../middleware/auth");

router.use(auth);

// ── GET /api/warehouses ──────────────────────────────────────────────────
router.get("/", (req, res) => {
  const warehouses = db.prepare("SELECT * FROM warehouses ORDER BY name").all();
  const locations  = db.prepare("SELECT * FROM locations ORDER BY name").all();

  const result = warehouses.map(w => ({
    ...w,
    locations: locations.filter(l => l.warehouse_id === w.id),
  }));

  res.json(result);
});

// ── POST /api/warehouses ─────────────────────────────────────────────────
router.post("/", (req, res) => {
  const { name, address, coordinates } = req.body;
  if (!name) return res.status(400).json({ error: "name is required." });

  const r = db
    .prepare("INSERT INTO warehouses (name, address, coordinates) VALUES (?,?,?)")
    .run(name, address || null, coordinates || null);

  res.status(201).json(db.prepare("SELECT * FROM warehouses WHERE id = ?").get(r.lastInsertRowid));
});

// ── PUT /api/warehouses/:id ──────────────────────────────────────────────
router.put("/:id", (req, res) => {
  const { name, address, coordinates } = req.body;
  db.prepare(`
    UPDATE warehouses
    SET name = COALESCE(?, name),
        address = COALESCE(?, address),
        coordinates = COALESCE(?, coordinates)
    WHERE id = ?
  `).run(name, address, coordinates, req.params.id);

  res.json(db.prepare("SELECT * FROM warehouses WHERE id = ?").get(req.params.id));
});

// ── DELETE /api/warehouses/:id ───────────────────────────────────────────
router.delete("/:id", (req, res) => {
  const hasStock = db
    .prepare(`SELECT s.id FROM stock s JOIN locations l ON l.id = s.location_id
              WHERE l.warehouse_id = ? AND s.quantity > 0 LIMIT 1`)
    .get(req.params.id);
  if (hasStock) return res.status(400).json({ error: "Cannot delete warehouse with active stock." });

  db.prepare("DELETE FROM warehouses WHERE id = ?").run(req.params.id);
  res.json({ message: "Warehouse deleted." });
});

// ── GET /api/warehouses/:id/locations ────────────────────────────────────
router.get("/:id/locations", (req, res) => {
  const locs = db
    .prepare("SELECT * FROM locations WHERE warehouse_id = ? ORDER BY name")
    .all(req.params.id);
  res.json(locs);
});

// ── POST /api/warehouses/:id/locations ───────────────────────────────────
router.post("/:id/locations", (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name is required." });

  const wh = db.prepare("SELECT id FROM warehouses WHERE id = ?").get(req.params.id);
  if (!wh) return res.status(404).json({ error: "Warehouse not found." });

  const r = db
    .prepare("INSERT INTO locations (warehouse_id, name) VALUES (?,?)")
    .run(req.params.id, name);

  res.status(201).json(db.prepare("SELECT * FROM locations WHERE id = ?").get(r.lastInsertRowid));
});

// ── PUT /api/warehouses/locations/:locId ─────────────────────────────────
router.put("/locations/:locId", (req, res) => {
  const { name } = req.body;
  db.prepare("UPDATE locations SET name = COALESCE(?, name) WHERE id = ?").run(name, req.params.locId);
  res.json(db.prepare("SELECT * FROM locations WHERE id = ?").get(req.params.locId));
});

// ── DELETE /api/warehouses/locations/:locId ───────────────────────────────
router.delete("/locations/:locId", (req, res) => {
  const hasStock = db
    .prepare("SELECT id FROM stock WHERE location_id = ? AND quantity > 0 LIMIT 1")
    .get(req.params.locId);
  if (hasStock) return res.status(400).json({ error: "Cannot delete location with active stock." });

  db.prepare("DELETE FROM locations WHERE id = ?").run(req.params.locId);
  res.json({ message: "Location deleted." });
});

module.exports = router;
