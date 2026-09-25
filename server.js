require("dotenv").config(); // Load environment variables from .env file

const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const jwt = require("jsonwebtoken");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.SECRET_KEY || "rahsia_e_relief_key";

// 1. Middlewares
app.use(cors());
app.use(express.json());

// 2. Database Connection & Schema Setup
const db = new sqlite3.Database("./database.db", (err) => {
  if (err) {
    console.error("Ralat SQLite:", err.message);
  } else {
    console.log("Berjaya bersambung ke SQLite.");
    // Aktifkan sokongan Foreign Key
    db.run("PRAGMA foreign_keys = ON;");
  }
});

db.serialize(() => {
  db.run(`
        CREATE TABLE IF NOT EXISTS teachers (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            name TEXT NOT NULL, 
            session TEXT DEFAULT 'Pagi', 
            max_relief INTEGER DEFAULT 3, 
            tags TEXT
        )
    `);

  db.run(`
        CREATE TABLE IF NOT EXISTS reliefs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            date TEXT NOT NULL, 
            time_slot TEXT NOT NULL, 
            class_name TEXT NOT NULL, 
            subject TEXT, 
            original_teacher_id INTEGER, 
            relief_teacher_id INTEGER, 
            status TEXT DEFAULT 'confirmed',
            FOREIGN KEY (original_teacher_id) REFERENCES teachers(id) ON DELETE SET NULL,
            FOREIGN KEY (relief_teacher_id) REFERENCES teachers(id) ON DELETE SET NULL
        )
    `);
});

// 3. JWT Verification Middleware
function verifyToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token)
    return res
      .status(401)
      .json({ error: "Akses ditolak. Token tidak disediakan." });

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err)
      return res
        .status(403)
        .json({ error: "Token tidak sah atau telah luput." });
    req.user = user;
    next();
  });
}

// 4. API Routes

// Route Asas (Healthcheck)
app.get("/", (req, res) => {
  res.send("Pelayan API Relief Pintar Berjalan dengan Jayanya!");
});

// Auth Login
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res
      .status(400)
      .json({ error: "Sila berikan nama pengguna dan kata laluan." });
  }

  if (username === "admin" && password === "admin123") {
    const token = jwt.sign({ username }, SECRET_KEY, { expiresIn: "8h" });
    return res.json({ status: "success", token });
  }
  res
    .status(401)
    .json({ error: "Log masuk gagal. Nama pengguna atau kata laluan salah." });
});

// ==================== GURU (TEACHERS) ====================

// GET: Semua Guru
app.get("/api/teachers", verifyToken, (req, res) => {
  db.all("SELECT * FROM teachers ORDER BY name ASC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// GET: Guru Mengikut ID
app.get("/api/teachers/:id", verifyToken, (req, res) => {
  const { id } = req.params;
  db.get("SELECT * FROM teachers WHERE id = ?", [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "Guru tidak dijumpai." });
    res.json(row);
  });
});

// POST: Tambah Guru Baru
app.post("/api/teachers", verifyToken, (req, res) => {
  const { name, session, max_relief, tags } = req.body;
  if (!name) return res.status(400).json({ error: "Nama guru adalah wajib." });

  db.run(
    "INSERT INTO teachers (name, session, max_relief, tags) VALUES (?, ?, ?, ?)",
    [name, session || "Pagi", max_relief || 3, tags || ""],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({
        status: "success",
        id: this.lastID,
        message: "Guru berjaya ditambah.",
      });
    }
  );
});

// PUT: Kemaskini Guru
app.put("/api/teachers/:id", verifyToken, (req, res) => {
  const { id } = req.params;
  const { name, session, max_relief, tags } = req.body;

  if (!name) return res.status(400).json({ error: "Nama guru adalah wajib." });

  db.run(
    "UPDATE teachers SET name = ?, session = ?, max_relief = ?, tags = ? WHERE id = ?",
    [name, session || "Pagi", max_relief ?? 3, tags || "", id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0)
        return res.status(404).json({ error: "Guru tidak dijumpai." });
      res.json({
        status: "success",
        message: "Maklumat guru berjaya dikemaskini.",
      });
    }
  );
});

// DELETE: Padam Guru
app.delete("/api/teachers/:id", verifyToken, (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM teachers WHERE id = ?", [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0)
      return res.status(404).json({ error: "Guru tidak dijumpai." });
    res.json({ status: "success", message: "Guru berjaya dipadam." });
  });
});

// ==================== GENERATOR RELIEF ====================

app.post("/api/generate-relief", verifyToken, (req, res) => {
  const { slot, date, availableTeachers } = req.body;

  if (!Array.isArray(availableTeachers) || availableTeachers.length === 0) {
    return res
      .status(400)
      .json({ status: "failed", message: "Tiada guru luang disediakan." });
  }

  let bestCandidate = null;
  let highestScore = -999;

  availableTeachers.forEach((candidate) => {
    let score = 100 - (candidate.current_load || 0) * 10;
    if (score > highestScore) {
      highestScore = score;
      bestCandidate = candidate;
    }
  });

  if (bestCandidate) {
    res.json({
      status: "success",
      assigned_to: bestCandidate,
      score: highestScore,
    });
  } else {
    res.json({ status: "failed", message: "Tiada calon guru yang sesuai." });
  }
});

// ==================== JADUAL RELIEF ====================

// GET: Ambil Semua Jadual Relief (dengan gabungan nama guru)
app.get("/api/reliefs", verifyToken, (req, res) => {
  const query = `
        SELECT 
            r.*, 
            t1.name AS original_teacher_name, 
            t2.name AS relief_teacher_name 
        FROM reliefs r
        LEFT JOIN teachers t1 ON r.original_teacher_id = t1.id
        LEFT JOIN teachers t2 ON r.relief_teacher_id = t2.id
        ORDER BY r.date DESC, r.time_slot ASC
    `;

  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// POST: Simpan Senarai Relief (dengan Transaksi)
app.post("/api/reliefs", verifyToken, (req, res) => {
  const { reliefs } = req.body;
  if (!reliefs || !Array.isArray(reliefs) || reliefs.length === 0) {
    return res
      .status(400)
      .json({ error: "Data reliefs tidak sah atau kosong." });
  }

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    const stmt = db.prepare(
      "INSERT INTO reliefs (date, time_slot, class_name, subject, original_teacher_id, relief_teacher_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );

    let errorOccurred = false;

    reliefs.forEach((r) => {
      if (errorOccurred) return;

      stmt.run(
        [
          r.date,
          r.time_slot,
          r.class_name,
          r.subject || null,
          r.original_teacher_id || null,
          r.relief_teacher_id || null,
          r.status || "confirmed",
        ],
        function (err) {
          if (err) {
            console.error("Ralat simpan relief:", err.message);
            errorOccurred = true;
          }
        }
      );
    });

    stmt.finalize((err) => {
      if (err || errorOccurred) {
        db.run("ROLLBACK");
        return res.status(500).json({
          error:
            "Gagal menyimpan senarai relief. Transaksi dibatalkan (ROLLBACK).",
        });
      }

      db.run("COMMIT", (commitErr) => {
        if (commitErr) {
          return res
            .status(500)
            .json({ error: "Gagal menyelesaikan transaksi (COMMIT error)." });
        }
        res.status(201).json({
          status: "success",
          message: "Senarai relief berjaya disimpan.",
        });
      });
    });
  });
});

// DELETE: Padam Rekod Relief Mengikut ID
app.delete("/api/reliefs/:id", verifyToken, (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM reliefs WHERE id = ?", [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0)
      return res.status(404).json({ error: "Rekod relief tidak dijumpai." });
    res.json({ status: "success", message: "Rekod relief berjaya dipadam." });
  });
});

// 5. Jalankan Pelayan (Server)
app.listen(PORT, () => {
  console.log(`Pelayan berjalan di http://localhost:${PORT}`);
});