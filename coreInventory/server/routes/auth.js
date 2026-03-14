// server/routes/auth.js
// POST /api/auth/signup
// POST /api/auth/login
// POST /api/auth/forgot-password   (sends OTP)
// POST /api/auth/verify-otp        (verifies OTP, returns reset token)
// POST /api/auth/reset-password    (sets new password)

const router  = require("express").Router();
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");
const db      = require("../db");

// ── helpers ─────────────────────────────────────────────────────────────
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

async function sendOTPEmail(email, otp) {
  // Only sends if MAIL_USER is configured; otherwise logs to console (dev mode)
  if (!process.env.MAIL_USER) {
    console.log(`[DEV] OTP for ${email}: ${otp}`);
    return;
  }
  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host: process.env.MAIL_HOST,
    port: Number(process.env.MAIL_PORT),
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
  });
  await transporter.sendMail({
    from: process.env.MAIL_FROM,
    to: email,
    subject: "CoreInventory — Password Reset OTP",
    text: `Your OTP is: ${otp}\n\nIt expires in 10 minutes. Do not share it.`,
  });
}

// ── POST /api/auth/signup ────────────────────────────────────────────────
router.post("/signup", async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: "name, email, password are required." });

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) return res.status(409).json({ error: "Email already registered." });

  const hash = await bcrypt.hash(password, 10);
  const allowed_role = ["manager", "staff"].includes(role) ? role : "staff";

  const result = db
    .prepare("INSERT INTO users (name, email, password, role) VALUES (?,?,?,?)")
    .run(name, email, hash, allowed_role);

  const user = db.prepare("SELECT id, name, email, role FROM users WHERE id = ?").get(result.lastInsertRowid);
  res.status(201).json({ token: signToken(user), user });
});

// ── POST /api/auth/login ─────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "email and password are required." });

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) return res.status(401).json({ error: "Invalid email or password." });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: "Invalid email or password." });

  const { password: _, ...safeUser } = user;
  res.json({ token: signToken(safeUser), user: safeUser });
});

// ── POST /api/auth/forgot-password ──────────────────────────────────────
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "email is required." });

  const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  // Always return success to avoid user enumeration
  if (!user) return res.json({ message: "If that email exists, an OTP has been sent." });

  const otp = generateOTP();
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // +10 min

  db.prepare("UPDATE otp_tokens SET used = 1 WHERE user_id = ? AND used = 0").run(user.id);
  db.prepare("INSERT INTO otp_tokens (user_id, otp, expires_at) VALUES (?,?,?)").run(user.id, otp, expires);

  await sendOTPEmail(email, otp);
  res.json({ message: "If that email exists, an OTP has been sent." });
});

// ── POST /api/auth/verify-otp ────────────────────────────────────────────
router.post("/verify-otp", (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: "email and otp are required." });

  const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (!user) return res.status(400).json({ error: "Invalid request." });

  const token = db
    .prepare(
      `SELECT * FROM otp_tokens
       WHERE user_id = ? AND otp = ? AND used = 0
         AND expires_at > datetime('now')
       ORDER BY id DESC LIMIT 1`
    )
    .get(user.id, otp);

  if (!token) return res.status(400).json({ error: "OTP is invalid or expired." });

  db.prepare("UPDATE otp_tokens SET used = 1 WHERE id = ?").run(token.id);

  // Issue a short-lived reset token (5 min)
  const resetToken = jwt.sign({ id: user.id, purpose: "reset" }, process.env.JWT_SECRET, { expiresIn: "5m" });
  res.json({ resetToken });
});

// ── POST /api/auth/reset-password ────────────────────────────────────────
router.post("/reset-password", async (req, res) => {
  const { resetToken, newPassword } = req.body;
  if (!resetToken || !newPassword)
    return res.status(400).json({ error: "resetToken and newPassword are required." });

  let payload;
  try {
    payload = jwt.verify(resetToken, process.env.JWT_SECRET);
  } catch {
    return res.status(400).json({ error: "Reset token is invalid or expired." });
  }

  if (payload.purpose !== "reset")
    return res.status(400).json({ error: "Invalid token purpose." });

  const hash = await bcrypt.hash(newPassword, 10);
  db.prepare("UPDATE users SET password = ? WHERE id = ?").run(hash, payload.id);
  res.json({ message: "Password updated successfully." });
});

module.exports = router;
