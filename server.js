const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const jwt = require("jsonwebtoken");
const cors = require("cors");

const app = express();
const PORT = 3000;
const SECRET_KEY = "rahsia_e_relief_key";

app.use(cors());
app.use(express.json());

const db = new sqlite3.Database("./database.db", (err) => {
    if (err) console.error("Ralat SQLite:", err.message);
    else console.log("Berjaya bersambung ke SQLite.");
});

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS teachers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, session TEXT, max_relief INTEGER, tags TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS reliefs (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT, time_slot TEXT, class_name TEXT, subject TEXT, original_teacher_id INTEGER, relief_teacher_id INTEGER, status TEXT)");
});

function verifyToken(req, res, next) {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (!token) return res.status(401).json({ error: "Akses ditolak." });

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ error: "Token tidak sah." });
        req.user = user;
        next();
    });
}

app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    if (username === "admin" && password === "admin123") {
        const token = jwt.sign({ username }, SECRET_KEY, { expiresIn: "8h" });
        return res.json({ status: "success", token });
    }
    res.status(401).json({ error: "Log masuk gagal." });
});

app.get("/api/teachers", verifyToken, (req, res) => {
    db.all("SELECT * FROM teachers", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.post("/api/teachers", verifyToken, (req, res) => {
    const { name, session, max_relief, tags } = req.body;
    db.run("INSERT INTO teachers (name, session, max_relief, tags) VALUES (?, ?, ?, ?)", [name, session, max_relief, tags], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ status: "success", id: this.lastID });
    });
});

app.post("/api/generate-relief", verifyToken, (req, res) => {
    const { slot, date, availableTeachers } = req.body;
    let bestCandidate = null;
    let highestScore = -999;

    availableTeachers.forEach(candidate => {
        let score = 100 - (candidate.current_load * 10);
        if (score > highestScore) {
            highestScore = score;
            bestCandidate = candidate;
        }
    });

    if (bestCandidate) {
        res.json({ status: "success", assigned_to: bestCandidate, score: highestScore });
    } else {
        res.json({ status: "failed", message: "Tiada guru luang." });
    }
});

app.post("/api/reliefs", verifyToken, (req, res) => {
    const { reliefs } = req.body;
    if (!reliefs || !Array.isArray(reliefs)) return res.status(400).json({ error: "Data tidak sah." });

    const stmt = db.prepare("INSERT INTO reliefs (date, time_slot, class_name, subject, original_teacher_id, relief_teacher_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)");
    db.serialize(() => {
        reliefs.forEach(r => {
            stmt.run(r.date, r.time, r.class, r.subject, r.original, r.relief, "confirmed");
        });
        stmt.finalize();
    });

    res.json({ status: "success", message: "Jadual relief disimpan!" });
});

app.get("/api/reliefs", verifyToken, (req, res) => {
    const { date } = req.query;
    db.all("SELECT * FROM reliefs WHERE date = ?", [date], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.listen(PORT, () => {
    console.log("[API Server] Pelayan e-Relief AKTIF di http://localhost:" + PORT);
});
