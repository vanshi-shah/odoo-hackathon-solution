// CoreInventory — Express entry point

require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const path    = require("path");

// ── Import DB (runs schema creation on startup) ──────────────────────────
require("./db");

// ── Routes ───────────────────────────────────────────────────────────────
const authRouter        = require("./routes/auth");
const dashboardRouter   = require("./routes/dashboard");
const productsRouter    = require("./routes/products");
const warehousesRouter  = require("./routes/warehouses");
const receiptsRouter    = require("./routes/receipts");
const deliveriesRouter  = require("./routes/deliveries");
const transfersRouter   = require("./routes/transfers");
const adjustmentsRouter = require("./routes/adjustments");
const moveHistoryRouter = require("./routes/moveHistory");

// ── App ──────────────────────────────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json());

// Serve frontend static files from /public
app.use(express.static(path.join(__dirname, "..", "public")));

// ── API Routes ───────────────────────────────────────────────────────────
app.use("/api/auth",        authRouter);
app.use("/api/dashboard",   dashboardRouter);
app.use("/api/products",    productsRouter);
app.use("/api/warehouses",  warehousesRouter);
app.use("/api/receipts",    receiptsRouter);
app.use("/api/deliveries",  deliveriesRouter);
app.use("/api/transfers",   transfersRouter);
app.use("/api/adjustments", adjustmentsRouter);
app.use("/api/moves",       moveHistoryRouter);

// ── Health check ─────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// ── Catch-all: serve index.html for any non-API route (SPA fallback) ─────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

// ── Start ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  CoreInventory server running at http://localhost:${PORT}\n`);
});
