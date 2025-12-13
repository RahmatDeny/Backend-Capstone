Deploying this backend to Replit
===============================

Quick steps
1. Push your repository to GitHub (if not already).
2. Go to https://replit.com and sign in.
3. Create -> Import from GitHub -> choose the repository. If asked, import the whole repo.
4. After import, open the Repl. In the left file tree, navigate to `backend/` and open the `.replit` file (this repo includes `backend/.replit` to make running the backend easy).
5. Ensure Replit's Run button is configured to run from the `backend` folder. If Replit opened the project at repo root, change the Run command in the Replit UI to:

   npm install && cd backend && npm start

   or if you imported only the `backend` folder as a Repl, the provided `.replit` runs `npm install && npm start` automatically.

Environment variables (Secrets)
- Set these environment variables in Replit (Secrets/Environment variables):
  - PORT (optional, default 9000)
  - ML_API_BASE (if ML API runs separately; default http://127.0.0.1:5001)
  - GEMINI_API_KEY (if you use Gemini endpoints)
  - GEMINI_MODEL (optional)
  - OLLAMA_BASE_URL (if using local Ollama)
  - OLLAMA_MODEL (if using Ollama)
  - CORS_ORIGINS (recommended for production)

    Example (single origin):
      https://your-frontend.vercel.app

    Example (multiple origins):
      https://your-frontend.vercel.app,https://staging-your-project.vercel.app

  - Notes: `CORS_ORIGINS` is a comma-separated list of allowed origins. If unset, the backend uses permissive CORS (development convenience). For security in production, set this to your Vercel frontend domain(s).

Notes & caveats
- Replit provides a development friendly environment but has limits for production:
  - Files saved to the filesystem may not be robust for long-term storage; use S3/Cloud Storage for uploads and model files in production.
  - Replit may put the app to sleep if idle; for reliably always-on apps use Render/Railway or a VPS.
  - For heavy ML jobs or GPU needs, use a dedicated ML host.

Testing
- After starting, your backend health endpoint should be reachable at `https://<your-repl>.repl.co/health` or `http://localhost:<PORT>/health` in the Repl console preview.

Frontend connection example
- In Vercel (frontend project) set Environment Variable:
  - `VITE_ML_API_BASE` = `https://<your-repl>.repl.co`

  This will cause the frontend to call e.g. `${import.meta.env.VITE_ML_API_BASE}/api/ml/health`.

Verification (end-to-end):
1. Ensure Replit backend is running and `https://<your-repl>.repl.co/health` returns status ok.
2. Set `CORS_ORIGINS` in Replit to your Vercel domain `https://<your-frontend>.vercel.app`.
3. Set `VITE_ML_API_BASE` in Vercel to `https://<your-repl>.repl.co`.
4. Open the frontend app and test API-driven pages (Recommendations). Use browser DevTools Network tab to see requests go to the backend domain and check responses.

If you see CORS errors in the browser console, double-check `CORS_ORIGINS` is set correctly (include https:// and no trailing slash) and redeploy/restart the Repl.

If you want, I can create a small `.replit` at repo root instead, or add a simple Procfile for other hosts.