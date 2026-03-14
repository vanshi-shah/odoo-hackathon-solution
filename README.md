# odoo-hackathon-solution
# CoreInventory 📦
### A locally-run Inventory Management System 

---

## Hi there!

CoreInventory is a web app that helps businesses track their stock — what's coming in, what's going out, and what's running low. Instead of juggling spreadsheets or paper registers, everything lives in one clean dashboard.

This was built as a hackathon project using simple, beginner-friendly tools: plain HTML/CSS/JS for the frontend, Node.js for the backend, and SQLite as a lightweight local database.

---

## What problem does it solve?

Small and mid-size businesses often track inventory manually — in notebooks, Excel sheets, or just by memory. This leads to:

- Stock running out without warning
- No record of who received or dispatched goods
- No way to know where items are stored

CoreInventory replaces all of that with a real-time, organized system that anyone on the team can use.

---

##  Features at a glance

- **Dashboard** — a live snapshot of all inventory operations with KPIs
- **Receipts** — logging goods arriving from suppliers
- **Deliveries** — tracking goods going out to customers
- **Internal Transfers** — moving stock between locations or warehouses
- **Stock Adjustments** — correcting counts after a physical check
- **Move History** — a full audit trail of every stock movement
- **Products** — managing the item catalogue with low-stock alerts
- **Auth** — secure login with JWT, and OTP-based password reset

---

##  Tech Stack

| Layer | Technology | Why we chose it |
|-------|-----------|-----------------|
| Frontend | HTML, CSS, Vanilla JS | No build tools needed, easy to understand |
| Backend | Node.js + Express | Lightweight and beginner-friendly |
| Database | SQLite | File-based, no server setup required |
| Auth | JWT + bcrypt | Industry-standard, secure |

---

##  Getting it running locally

There's one thing needed before starting — **Node.js v20 LTS**.

👉 Download it here: https://nodejs.org (pick the LTS version)

Once that's installed, getting the app running is straightforward:

**On Windows — just double-click `start.bat`**

That's it. The script will:
1. Install all dependencies automatically (first time only)
2. Start the server
3. Open the browser at the right page

The app will be available at: **http://localhost:3000/login.html**

---

**Prefer doing it manually? Here's how:**

```bash
# Navigate into the project folder
cd coreinventory

# Install dependencies
npm install

# Start the server
node server/index.js
```

Then open `http://localhost:3000/login.html` in the browser.

> 💬 The terminal window needs to stay open while using the app — closing it stops the server. Think of it like keeping the app "on".

---

##  Sample login credentials

The app comes pre-loaded with sample data for demo purposes.

| Name | Email | Password | Role |
|------|-------|----------|------|
| Arjun Mehta | arjun@coreinventory.com | admin123 | Manager |
| Priya Shah | priya@coreinventory.com | staff123 | Staff |
| Rohan Desai | rohan@coreinventory.com | manager123 | Manager |

Sample data includes 10 products, 2 warehouses, 5 receipts, 5 deliveries, 5 transfers, and a full move history — ready for a live demo.

---

##  Project structure

```
coreinventory/
│
├── start.bat              ← One double-click to launch (Windows)
│
├── public/                ← All the pages the user sees
│   ├── login.html
│   ├── signup.html
│   └── dashboard.html
│
├── server/
│   ├── index.js           ← The Express server
│   ├── db.js              ← Database schema + sample data
│   ├── middleware/
│   │   └── auth.js        ← Login protection
│   └── routes/
│       ├── auth.js        ← Signup / login / OTP reset
│       ├── dashboard.js   ← KPI data
│       ├── products.js    ← Product management
│       ├── warehouses.js  ← Warehouses & locations
│       ├── receipts.js    ← Incoming goods
│       ├── deliveries.js  ← Outgoing goods
│       ├── transfers.js   ← Internal transfers
│       ├── adjustments.js ← Stock corrections
│       └── moveHistory.js ← Stock ledger
│
├── coreinventory.db       ← Auto-created database (don't edit manually)
├── .env                   ← App config
└── package.json
```

---

##  Why does it need a server to run?

Unlike a static website, CoreInventory has a real backend that handles:

- Storing and retrieving data from a database
- Verifying logins securely
- Running business logic (like checking if there's enough stock before a delivery)

This also means it works **completely offline** — no internet connection needed, no data sent anywhere. Everything stays on the local machine.

---

##  Configuration

The `.env` file holds app settings. These can be left as-is for local use:

```
PORT=3000
JWT_SECRET=change_this_to_a_random_string
JWT_EXPIRES_IN=7d
```

For OTP password reset emails to actually send, a Gmail address and App Password can be added:

```
MAIL_HOST=smtp.gmail.com
MAIL_PORT=587
MAIL_USER=your_email@gmail.com
MAIL_PASS=your_gmail_app_password
```

Without this, OTPs will print in the terminal instead — which works fine for development.

---
Thank You!