## Backend (Express, port 9000)

Endpoints utama:
- `GET /health` – status backend.
- `GET /api/ml/health` – proxy health Flask ML API.
- `GET /api/ml/datasets` + `/api/ml/datasets/:name` – akses CSV processed/normalized.
- `GET /api/ml/ml-ready` + `/api/ml/ml-ready/:task/:split` – akses ML-ready split.
- `POST /api/ml/upload` – upload file.
- `POST /api/ml/predict/batch` – panggil semua task ML sekaligus (production_forecasting, equipment_failure, price_prediction, road_maintenance, route_optimization).
- `POST /api/ai/gemini-chat` – chat Gemini dengan konteks prediksi ML.
- `POST /api/ai/chat` – Ollama lokal (opsional).

Env contoh (`backend/.env`):
```
PORT=9000
ML_API_BASE=http://127.0.0.1:5001
GEMINI_API_KEY=your_key
GEMINI_MODEL=gemini-1.5-flash
```

Cara jalan:
```
npm install
npm run dev   # atau npm start
```

Catatan:
- Pastikan Flask ML API aktif di `ML_API_BASE`.
- `GEMINI_API_KEY` wajib diisi agar `/api/ai/gemini-chat` berfungsi.
- Batch predict akan mem-forward payload sesuai `mlPayloads` dari frontend; jika field tidak diisi, nilai default bisa digunakan.
