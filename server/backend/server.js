require('dotenv').config();
// Also load the root .env so OPENAI_API_KEY can be set once at the project root
require('dotenv').config({
  path: require('path').join(__dirname, '../../.env'),
  override: false
});
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/users');
const resumeRoutes = require('./src/routes/resumes');
const chatHistoryRoutes = require('./src/routes/chatHistory');
const adminRoutes = require('./src/routes/admin');
const db = require('./src/store/jsonDb');

const app = express();
const PORT = process.env.PORT || 6291;

app.use(helmet());

const allowedOrigins = [
  'https://autobid.duckdns.org:6291',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:6291',
  'http://127.0.0.1:6291',
  /^chrome-extension:\/\//
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    const allowed = allowedOrigins.some(o =>
      typeof o === 'string' ? o === origin : o.test(origin)
    );
    if (allowed) return callback(null, true);
    callback(new Error(`CORS policy: origin ${origin} not allowed`));
  },
  credentials: true
}));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use(limiter);

app.use(express.json({ limit: '10mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.get('/health', async (req, res) => {
  try {
    await db.getUsers();
    res.json({ status: 'ok', storage: 'json', timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/resumes', resumeRoutes);
app.use('/api/chat-history', chatHistoryRoutes);
app.use('/api/admin', adminRoutes);

// Browser hits :6291/ — API only during dev; stale `dist/` would hide Vite live reload.
const frontendDist = path.join(__dirname, '../frontend/dist');
const indexHtml = path.join(frontendDist, 'index.html');
const isProduction = process.env.NODE_ENV === 'production';
const distExists = fs.existsSync(indexHtml);
const serveBuiltDashboard = isProduction && distExists;

if (serveBuiltDashboard) {
  app.use(express.static(frontendDist));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.resolve(indexHtml));
  });
} else {
  if (distExists && !isProduction) {
    console.log(
      '[SERVER] Ignoring server/frontend/dist while NODE_ENV is not "production" — use Vite for the UI.'
    );
    console.log('[SERVER] Open the dashboard at http://127.0.0.1:5173 (not :6291) when running npm run dev.');
  }
  app.get('/', (_req, res) => {
    res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Mongtro API</title>
<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:2.5rem auto;padding:0 1.25rem;line-height:1.55;color:#1a1a1a}
code{background:#f0f0f0;padding:.12em .4em;border-radius:4px;font-size:.95em}
a{color:#2563eb;font-weight:600}</style></head><body>
<h1>Mongtro API</h1>
<p>This port (<code>6291</code>) is the <strong>REST API</strong>. During <code>npm run dev</code> the <strong>live dashboard</strong> runs on Vite — port <strong>5173</strong>.</p>
<p style="font-size:1.1rem;margin:1rem 0"><a href="http://127.0.0.1:5173">Open dashboard → http://127.0.0.1:5173</a></p>
<ul>
  <li>Health: <a href="/health"><code>/health</code></a></li>
  <li>API: <code>/api/…</code></li>
</ul>
<p style="color:#555;font-size:14px">If you opened <code>localhost:6291</code> expecting the latest UI, that was an old build. Use the link above while developing.</p>
<p style="color:#555;font-size:14px">To serve the built UI on this port, set <code>NODE_ENV=production</code> and run <code>npm run build</code> in <code>server/frontend</code>.</p>
</body></html>`);
  });
}

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  if (err.message.startsWith('CORS')) return res.status(403).json({ error: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, '127.0.0.1', async () => {
  console.log(`[SERVER] http://127.0.0.1:${PORT}`);
  console.log('[STORE] JSON files under server/backend/data/');
  try {
    await db.getUsers();
    console.log('[STORE] Ready');
  } catch (e) {
    console.error('[STORE] Init error:', e.message);
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[SERVER] Port ${PORT} is already in use (another API instance or app).`);
    console.error(`  Stop it, or set PORT in backend/.env. Find PID: netstat -ano | findstr :${PORT}`);
  } else {
    console.error('[SERVER] Listen error:', err.message);
  }
  process.exit(1);
});
