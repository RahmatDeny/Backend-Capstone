const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { parse } = require("csv-parse");
const axios = require("axios");
require("dotenv").config();

// ================== APP SETUP ==================
const app = express();
const PORT = process.env.PORT || 9000;
const ML_API_BASE =
  process.env.ML_API_BASE || "http://127.0.0.1:5001";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-1.5-flash";

// CORS: gunakan whitelist bila diset via env var CORS_ORIGINS (comma-separated).
// Jika tidak diset, default ke permissive CORS (development convenience).
const corsOriginsEnv = process.env.CORS_ORIGINS || "";
let corsOptions = {};
if (corsOriginsEnv && corsOriginsEnv.trim().length > 0) {
  const allowedOrigins = corsOriginsEnv.split(",").map((s) => s.trim()).filter(Boolean);
  corsOptions = {
    origin: function (origin, callback) {
      // allow requests with no origin (mobile apps, curl, same-origin)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"), false);
    },
    optionsSuccessStatus: 200,
  };
  app.use(cors(corsOptions));
  console.log("CORS: whitelist enabled for origins:", allowedOrigins);
} else {
  // permissive for local/dev convenience. In production, set CORS_ORIGINS.
  app.use(cors());
  console.log("CORS: permissive mode (no CORS_ORIGINS set). Consider setting CORS_ORIGINS in production.");
}
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================== PATH & FOLDER ==================
const ML_DATA_DIR = path.join(__dirname, "..", "ml_data");
const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "ml");
const INGEST_DIR = path.join(UPLOAD_DIR, "ingest");
const FIELD_INPUT_PATH = path.join(INGEST_DIR, "field_inputs.json");
const FIELD_INPUT_HISTORY_PATH = path.join(
  INGEST_DIR,
  "field_inputs_history.jsonl"
);

fs.mkdirSync(ML_DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(INGEST_DIR, { recursive: true });

// Static untuk file upload
app.use("/uploads/ml", express.static(UPLOAD_DIR));
app.use("/uploads/ml/ingest", express.static(INGEST_DIR));

// ================== KONFIG DATASET ==================
const DATASETS = [
  "equipment",
  "operations",
  "price",
  "production",
  "roads",
  "vessels",
  "weather",
];

const ML_READY_TASKS = [
  "equipment_failure",
  "operational_efficiency",
  "price_prediction",
  "production_forecasting",
  "road_maintenance",
];
const GEMINI_TASKS = [
  "production_forecasting",
  "equipment_failure",
  "price_prediction",
  "road_maintenance",
  "route_optimization",
];

// ================== UTIL: GEMINI PROMPT ==================
function buildGeminiContents({ systemPrompt, context, message, history }) {
  const contents = [];

  // Guard-rail sebagai pembuka (Gemini tidak memiliki role "system" eksplisit)
  contents.push({
    role: "user",
    parts: [{ text: systemPrompt }],
  });

  (history || []).forEach((msg) => {
    if (!msg || !msg.text) return;
    contents.push({
      role:
        msg.sender === "AI" || msg.sender === "assistant"
          ? "model"
          : "user",
      parts: [{ text: String(msg.text) }],
    });
  });

  contents.push({
    role: "user",
    parts: [
      {
        text: JSON.stringify({
          context,
          question: message,
        }),
      },
    ],
  });

  return contents;
}

async function fetchMlPrediction(task, payload = {}) {
  try {
    const res = await axios.post(
      `${ML_API_BASE}/api/predict/${task}`,
      payload,
      { timeout: 15000 }
    );
    return res.data;
  } catch (err) {
    const message =
      err.response?.data?.message ||
      err.response?.data ||
      err.message ||
      "Unknown ML error";
    console.error(`[ML] ${task} error:`, message);
    return {
      status: "error",
      message,
    };
  }
}

// ================== HEALTHCHECK ==================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Mining ML backend is healthy",
    port: PORT,
  });
});

// ================== UTIL: BACA CSV ==================
function readCsvToJson(filePath, maxRows) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error("File not found"));
    }

    const rows = [];
    const parser = fs
      .createReadStream(filePath)
      .pipe(parse({ columns: true, skip_empty_lines: true }));

    parser.on("data", (row) => {
      // Batasi jumlah baris yang disimpan tanpa menghentikan stream,
      // supaya event 'end' tetap terpanggil dan Promise resolve.
      if (!maxRows || rows.length < maxRows) {
        rows.push(row);
      }
    });

    parser.on("end", () => {
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      resolve({ columns, rows });
    });

    parser.on("error", (err) => {
      reject(err);
    });
  });
}

function parseNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isNaN(num) ? fallback : num;
}

function normalize01(value, fallback = 0) {
  const num = parseNumber(value, fallback);
  if (num <= 1) return Math.max(0, Math.min(1, num));
  return Math.max(0, Math.min(1, num / 100));
}

function pickLatestByKey(rows, key = "road_id") {
  const map = new Map();
  rows.forEach((r) => {
    const id = r[key];
    if (!id) return;
    const ts = new Date(r.date || r.timestamp || r.day || 0).getTime();
    if (!map.has(id) || ts >= (map.get(id).ts || 0)) {
      map.set(id, { ts, row: r });
    }
  });
  return Array.from(map.values()).map((x) => x.row);
}

async function buildRoutePlan(mlPayloads = {}) {
  const payload = mlPayloads.route_optimization || {};
  const totalTrucks = parseNumber(payload.traffic_volume_trucks, 200);

  const filePath = path.join(ML_DATA_DIR, "roads_processed.csv");
  const { rows } = await readCsvToJson(filePath, 400);
  const latest = pickLatestByKey(rows, "road_id");

  if (!latest.length) {
    return {
      routes: [],
      summary: { totalTrucks, capacity: 0, note: "Tidak ada data roads_processed.csv" },
    };
  }

  // Hitung travel time, risiko, dan kapasitas efektif per segmen
  const scored = latest.map((r) => {
    const speed = parseNumber(r.average_speed_kmh, 25);
    const length = Math.max(0.1, parseNumber(r.length_km, 3));
    const density = normalize01(r.traffic_density, 0.5);
    const urgency = normalize01(r.maintenance_urgency, 0.5);
    const capacity = parseNumber(r.road_capacity, 150);
    const util = normalize01(r.capacity_utilization, 0.5);

    const risk = 0.5 * urgency + 0.3 * density + 0.2 * util;
    const effectiveSpeed = Math.max(5, speed * (1 - 0.4 * risk));
    const capacityTph = capacity * (1 - 0.25 * risk);
    const travelMinutes = (length / Math.max(0.1, effectiveSpeed)) * 60;
    const cost =
      travelMinutes * (1 + 0.5 * risk) +
      (1 - capacityTph / Math.max(capacity, 1)) * 10;

    return {
      id: r.road_id || r.road_type || "Road",
      type: r.road_type || "",
      risk,
      urgency,
      density,
      util,
      effectiveSpeed,
      capacityTph,
      travelMinutes,
      cost,
    };
  });

  const totalCapacity = scored.reduce((sum, r) => sum + Math.max(0, r.capacityTph), 0);
  if (totalCapacity === 0) {
    return {
      routes: [],
      summary: { totalTrucks, capacity: 0, note: "Kapasitas jalan 0" },
    };
  }

  // Alokasi truk dengan bobot biaya (cost) dan kapasitas efektif
  const routes = [];
  let remaining = totalTrucks;
  const sorted = [...scored].sort((a, b) => a.cost - b.cost);
  const costSum = sorted.reduce((sum, r) => sum + 1 / Math.max(r.cost, 0.1), 0);
  sorted.forEach((r, idx) => {
    const weight = (1 / Math.max(r.cost, 0.1)) / Math.max(costSum, 1);
    let share = Math.round(weight * totalTrucks);
    if (idx === sorted.length - 1) {
      share = remaining; // sisakan sisa ke rute terakhir
    }
    share = Math.max(0, Math.min(remaining, share));
    remaining -= share;

    routes.push({
      roadId: r.id,
      type: r.type,
      trucks: share,
      estTravelMinutes: Number(r.travelMinutes.toFixed(1)),
      effectiveSpeedKmh: Number(r.effectiveSpeed.toFixed(1)),
      riskScore: Number(r.risk.toFixed(2)),
      cost: Number(r.cost.toFixed(2)),
      density: Number(r.density.toFixed(2)),
      urgency: Number(r.urgency.toFixed(2)),
    });
  });

  const maintenanceWatch = routes
    .filter((r) => r.urgency >= 0.6 || r.riskScore >= 0.6)
    .sort((a, b) => b.urgency - a.urgency)
    .slice(0, 3)
    .map((r) => r.roadId);

  return {
    routes,
    summary: {
      totalTrucks,
      capacity: Number(totalCapacity.toFixed(1)),
      note: "Alokasi berbasis biaya travel (travel time + risiko) dan kapasitas roads_processed.csv",
      maintenanceWatch,
    },
  };
}

// ================== UTIL: PERSIST FIELD INPUTS ==================
function readFieldInputs() {
  if (!fs.existsSync(FIELD_INPUT_PATH)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(FIELD_INPUT_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn("Gagal membaca field inputs:", err.message);
    return null;
  }
}

function saveFieldInputs(data) {
  const payload = {
    savedAt: new Date().toISOString(),
    ...data,
  };
  fs.writeFileSync(FIELD_INPUT_PATH, JSON.stringify(payload, null, 2), "utf8");
  try {
    fs.appendFileSync(
      FIELD_INPUT_HISTORY_PATH,
      `${JSON.stringify(payload)}\n`,
      "utf8"
    );
  } catch (err) {
    console.warn("Gagal menulis history field input:", err.message);
  }
  return payload;
}

// ================== ENDPOINT: DATASET PROCESSED ==================
app.get("/api/ml/datasets", (req, res) => {
  res.json({
    status: "success",
    datasets: DATASETS,
  });
});

app.get("/api/ml/datasets/:name", async (req, res) => {
  try {
    const name = req.params.name;
    const normalized = req.query.normalized === "true";
    const maxRows = req.query.limit ? parseInt(req.query.limit, 10) : 200;

    if (!DATASETS.includes(name)) {
      return res.status(400).json({
        status: "error",
        message: `Unknown dataset: ${name}`,
      });
    }

    const fileName = normalized
      ? `${name}_normalized_processed.csv`
      : `${name}_processed.csv`;

    const filePath = path.join(ML_DATA_DIR, fileName);

    const { columns, rows } = await readCsvToJson(filePath, maxRows);

    res.json({
      status: "success",
      dataset: name,
      normalized,
      rowCount: rows.length,
      columns,
      rows,
    });
  } catch (err) {
    console.error("Error reading dataset", err);
    res.status(500).json({
      status: "error",
      message: "Failed to read dataset",
    });
  }
});

// ================== ENDPOINT: FIELD INPUT INGEST ==================
app.get("/api/ml/field-input", (_req, res) => {
  const data = readFieldInputs();
  if (!data) {
    return res.json({ status: "empty", message: "Belum ada data kondisi lapangan tersimpan." });
  }
  return res.json({ status: "success", data });
});

app.get("/api/ml/field-input/history", (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : 50;
    if (!fs.existsSync(FIELD_INPUT_HISTORY_PATH)) {
      return res.json({ status: "empty", entries: [] });
    }
    const lines = fs
      .readFileSync(FIELD_INPUT_HISTORY_PATH, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    const selected = lines.slice(-limit).map((line) => JSON.parse(line));
    return res.json({ status: "success", entries: selected.reverse() });
  } catch (err) {
    console.error("Baca history field-input gagal:", err);
    return res.status(500).json({ status: "error", message: "Gagal membaca history field-input." });
  }
});

app.post("/api/ml/field-input", (req, res) => {
  try {
    const {
      weather = {},
      roads = [],
      shipments = [],
      fleet = [],
      notes = "",
      mlPayloads = {},
    } = req.body || {};

    const saved = saveFieldInputs({
      weather,
      roads,
      shipments,
      fleet,
      notes,
      mlPayloads,
    });

    return res.json({
      status: "success",
      message: "Kondisi lapangan berhasil disimpan.",
      data: saved,
    });
  } catch (err) {
    console.error("Save field-input error:", err);
    return res.status(500).json({
      status: "error",
      message: "Gagal menyimpan kondisi lapangan.",
    });
  }
});

// ================== ENDPOINT: ML-READY DATASETS ==================
app.get("/api/ml/ml-ready", (req, res) => {
  res.json({
    status: "success",
    tasks: ML_READY_TASKS,
  });
});

app.get("/api/ml/ml-ready/:task/:split", async (req, res) => {
  try {
    const { task, split } = req.params;

    if (!ML_READY_TASKS.includes(task)) {
      return res.status(400).json({
        status: "error",
        message: `Unknown task: ${task}`,
      });
    }

    if (!["train", "test"].includes(split)) {
      return res.status(400).json({
        status: "error",
        message: 'Split must be "train" or "test"',
      });
    }

    const fileName = `${task}_${split}.csv`;
    const filePath = path.join(ML_DATA_DIR, "ml_ready", fileName);

    const { columns, rows } = await readCsvToJson(filePath, 200);

    res.json({
      status: "success",
      task,
      split,
      rowCount: rows.length,
      columns,
      rows,
    });
  } catch (err) {
    console.error("Error reading ml-ready dataset", err);
    res.status(500).json({
      status: "error",
      message: "Failed to read ml-ready dataset",
    });
  }
});

// ================== ENDPOINT: UPLOAD FILE ML ==================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, "_");
    cb(null, `${Date.now()}-${safeName}`);
  },
});

const allowedMimeTypes = [
  "text/csv",
  "application/json",
  "text/plain",
  "application/octet-stream",
  "application/vnd.ms-excel",
];

function fileFilter(req, file, cb) {
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`File type not allowed: ${file.mimetype}`));
  }
}

const upload = multer({ storage, fileFilter });

app.post("/api/ml/upload", upload.array("files", 10), (req, res) => {
  const files = (req.files || []).map((file) => ({
    originalName: file.originalname,
    storedName: file.filename,
    size: file.size,
    mimetype: file.mimetype,
    url: `/uploads/ml/${file.filename}`,
  }));

  res.json({
    status: "success",
    message: "ML files uploaded successfully",
    files,
  });
});

app.get("/api/ml/uploads", (req, res) => {
  fs.readdir(UPLOAD_DIR, (err, files) => {
    if (err) {
      console.error("Error listing uploads", err);
      return res.status(500).json({
        status: "error",
        message: "Failed to list uploads",
      });
    }

    res.json({
      status: "success",
      files,
    });
  });
});

// ================== ENDPOINT: AI CHAT (OLLAMA) ==================
app.post("/api/ai/chat", async (req, res) => {
  try {
    const { history = [], message } = req.body || {};

    if (!message || !message.trim()) {
      return res.status(400).json({
        status: "error",
        message: "Message wajib diisi.",
      });
    }

    const trimmedMessage = message.trim();

    // Bangun pesan percakapan untuk Ollama
    const systemPrompt =
      "Kamu adalah MiningOpt AI Assistant untuk operasi pertambangan. " +
      "Jawab dalam bahasa Indonesia yang rapi, jelas, dan singkat. " +
      "Jika ditanya soal cuaca, jadwal kapal, jalan tambang, atau target produksi, " +
      "beri rekomendasi yang logis dan aman.";

    const ollamaMessages = [
      {
        role: "system",
        content: systemPrompt,
      },
    ];

    (history || []).forEach((msg) => {
      if (!msg || !msg.text) return;

      const role =
        msg.sender === "AI" || msg.sender === "assistant" ? "assistant" : "user";

      ollamaMessages.push({
        role,
        content: String(msg.text),
      });
    });

    // Tambahkan pesan user terbaru
    ollamaMessages.push({
      role: "user",
      content: trimmedMessage,
    });

    const baseUrl = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
    const model = process.env.OLLAMA_MODEL || "llama3.1";

    const response = await axios.post(
      `${baseUrl}/api/chat`,
      {
        model,
        messages: ollamaMessages,
        stream: false,
      },
      {
        timeout: 60000,
      }
    );

    const data = response.data || {};
    const replyText =
      (data.message && data.message.content) ||
      data.reply ||
      "Maaf, saya belum bisa memberikan jawaban saat ini.";

    return res.json({
      status: "success",
      reply: replyText,
    });
  } catch (err) {
    console.error("AI chat (Ollama) error:", err.response?.data || err.message);
    return res.status(500).json({
      status: "error",
      message:
        "Terjadi kesalahan saat memanggil AI lokal (Ollama). Pastikan Ollama server sudah berjalan dan model sudah di-pull.",
    });
  }
});

// ================== ENDPOINT: AI CHAT (GEMINI + ML CONTEXT) ==================
app.post("/api/ai/gemini-chat", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        status: "error",
        message: "GEMINI_API_KEY belum diset di environment.",
      });
    }

    const { history = [], message, mlPayloads = {} } = req.body || {};

    if (!message || !message.trim()) {
      return res.status(400).json({
        status: "error",
        message: "Message wajib diisi.",
      });
    }

    // Ambil prediksi dari ML API (file pkl)
    const predictionPromises = GEMINI_TASKS.map((task) =>
      fetchMlPrediction(task, mlPayloads[task] || {})
    );
    const predictionResults = await Promise.all(predictionPromises);
    const context = {
      predictions: GEMINI_TASKS.reduce((acc, task, idx) => {
        acc[task] = predictionResults[idx];
        return acc;
      }, {}),
    };

    const systemPrompt =
      "Anda adalah MiningOpt AI Assistant untuk pertambangan batubara (Mining Value Chain Optimization). " +
      "Batasan: hanya jawab seputar tambang batubara, produksi, logistik, harga batubara, perawatan jalan/alat, dan rekomendasi operasional. " +
      'Jika pertanyaan di luar topik, jawab singkat: "Maaf, saya hanya menjawab topik pertambangan batubara dan rekomendasi operasional terkait." ' +
      'Jika data tidak tersedia, jawab: "data tidak tersedia". ' +
      "Jawaban ringkas, jelas, actionable, utamakan keselamatan dan kepatuhan.";

    const contents = buildGeminiContents({
      systemPrompt,
      context,
      message: message.trim(),
      history,
    });

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    const geminiResp = await axios.post(
      geminiUrl,
      { contents },
      { timeout: 20000 }
    );

    const reply =
      geminiResp.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Maaf, tidak ada jawaban.";

    return res.json({
      status: "success",
      reply,
      model: GEMINI_MODEL,
      contextSummary: Object.fromEntries(
        Object.entries(context.predictions || {}).map(([k, v]) => [
          k,
          v?.status || "unknown",
        ])
      ),
    });
  } catch (err) {
    console.error("AI chat (Gemini) error:", err.response?.data || err.message);
    return res.status(500).json({
      status: "error",
      message:
        "Terjadi kesalahan saat memanggil Gemini API. Periksa API key, koneksi, atau payload.",
    });
  }
});

// ================== ENDPOINT: ML HEALTH ==================
app.get("/api/ml/health", async (_req, res) => {
  try {
    const resp = await axios.get(`${ML_API_BASE}/health`, { timeout: 8000 });
    return res.json({ status: "success", ml: resp.data });
  } catch (err) {
    return res.status(500).json({
      status: "error",
      message:
        err.response?.data?.message ||
        err.message ||
        "Gagal memanggil ML API health",
    });
  }
});

// ================== ENDPOINT: ML PREDICT BATCH ==================
app.post("/api/ml/predict/batch", async (req, res) => {
  try {
    const mlPayloads = req.body?.mlPayloads || {};
    const predictionPromises = GEMINI_TASKS.map((task) =>
      fetchMlPrediction(task, mlPayloads[task] || {})
    );
    const predictionResults = await Promise.all(predictionPromises);
    const predictions = GEMINI_TASKS.reduce((acc, task, idx) => {
      acc[task] = predictionResults[idx];
      return acc;
    }, {});

    return res.json({ status: "success", predictions });
  } catch (err) {
    console.error("Batch prediction error:", err.response?.data || err.message);
    return res.status(500).json({
      status: "error",
      message: "Gagal memproses batch prediction.",
    });
  }
});

// ================== ENDPOINT: ROUTE PLAN (ALOKASI TRUK) ==================
app.post("/api/ml/route-plan", async (req, res) => {
  try {
    const mlPayloads = req.body?.mlPayloads || {};
    const plan = await buildRoutePlan(mlPayloads);
    return res.json({ status: "success", ...plan });
  } catch (err) {
    console.error("Route plan error:", err);
    return res.status(500).json({
      status: "error",
      message: "Gagal menghitung rencana rute/penjadwalan.",
    });
  }
});

// ================== START SERVER ==================
app.listen(PORT, () => {
  console.log(`ML backend listening on http://localhost:${PORT}`);
});
