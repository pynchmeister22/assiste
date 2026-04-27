# Mongtro Server

Express API plus React (Vite) dashboard for the **Mongtro** Chrome extension. All application data is stored as **JSON files** under `server/backend/data/` (no database server).

```
server/
  backend/    Express API (port 6291) + JSON store
  frontend/   React + Vite dashboard (port 5173 dev)
```

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | 18 + |

---

## Quick start

From the `server/` folder:

```bash
cd server
npm install
npm run install:all
cd backend && cp .env.example .env && node src/scripts/seed.js && cd ..
npm run dev
```

`npm run dev` runs the API and Vite together. Open **http://localhost:5173** — the dashboard signs in automatically. The API only accepts the fixed account **`moon`** / **`123456`** (see `server/backend/src/config/staticAuth.js`). On first run, `users.json` is created and the `moon` admin user is added if missing.

**Admin:** **http://localhost:5173/admin/dashboard** (or **Admin** in the sidebar).

### Run services separately

**Backend**

```bash
cd server/backend
cp .env.example .env
npm install
node src/scripts/seed.js
npm run dev
```

**Frontend**

```bash
cd server/frontend
npm install
npm run dev
```

---

## Data files (`server/backend/data/`)

| File | Contents |
|------|----------|
| `users.json` | Users (password hashes, optional `openaiApiKey`, admin flags) |
| `resumes.json` | Resume documents per user |
| `chatHistory.json` | Interview sessions and transcripts |

Back up this directory for backups/migration. It is created automatically when the API runs.

---

## Environment variables (`backend/.env`)

| Variable | Description |
|----------|-------------|
| `PORT` | API port (default `6291`, matches extension `config.js`) |
| `JWT_SECRET` | Secret used to sign JWTs — change in production |
| `JWT_EXPIRES_IN` | Token lifetime (default `7d`) |

Login is fixed in code: **`moon`** / **`123456`**. There is no registration API.

---

## API overview

Routes are under `/api`. Protected routes use `Authorization: Bearer <token>`.

### Auth

- `POST /api/auth/login` — `{ name, password }` → `{ token, user }` (only `moon` / `123456`)
- `GET /api/auth/user` — current user

### Users (admin)

- `GET /api/users` — list users
- `POST /api/users` — create user
- `PATCH /api/users/:id` — update user (including `openaiApiKey` for server-side key)
- `DELETE /api/users/:id` — deactivate user
- `GET /api/users/api-keys` — authenticated user: returns `{ openaiApiKey }` for the extension

### Resumes & chat history

Standard CRUD under `/api/resumes` and `/api/chat-history` (see route files for exact paths).

### Admin (`/api/admin/*`)

JWT + `isAdmin`. Stats, users, interviews, resumes (list/detail/delete). The React admin UI uses these routes.

---

## Extension integration

- **Production** API URL is set in `config.js` at the repo root.
- **Dev:** ensure `apiBaseUrl` points at `http://127.0.0.1:6291` (or your host) and run `npm run dev` so the API is listening.

Flow:

1. Extension signs in with `moon` / `123456` → JWT in `chrome.storage.local`
2. `GET /api/users/api-keys` — optional OpenAI key from the user record, cached for the extension
3. `GET /api/resumes` — resume picker
4. During interviews, the extension syncs to `POST /api/chat-history`

---

## Production notes

- Set `NODE_ENV=production` and a strong `JWT_SECRET`
- Serve the API behind HTTPS; build the frontend with `npm run build` in `frontend/` and serve `dist/`
