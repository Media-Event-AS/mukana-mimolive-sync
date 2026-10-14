// HTTP server: web UI + JSON API. Zero dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { loadConfig, saveConfig, updateConfig, publicConfig, FIELDS } from './config.js';
import { SyncEngine } from './sync.js';
import { MimoLive, discover } from './mimolive.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || '0.0.0.0';
const UI_PASSWORD = process.env.UI_PASSWORD || '';

let config = loadConfig();
const engine = new SyncEngine(
  () => config,
  (newRefresh) => {
    config.mukana.refreshToken = newRefresh;
    saveConfig(config);
  }
);

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  let data = '';
  for await (const c of req) {
    data += c;
    if (data.length > 1e6) throw new Error('Body too large');
  }
  return data ? JSON.parse(data) : {};
}

// Session cookie auth (works in embedded browsers that don't show Basic-auth dialogs).
// Basic auth header is still accepted for scripts/curl.
const sessions = new Set();
const SESSION_COOKIE = 'mms_session';

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function authorized(req) {
  if (!UI_PASSWORD) return true;
  const cookie = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(SESSION_COOKIE + '='));
  if (cookie && sessions.has(cookie.split('=')[1])) return true;
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const decoded = Buffer.from(h.slice(6), 'base64').toString();
    return safeEqual(decoded.slice(decoded.indexOf(':') + 1), UI_PASSWORD);
  }
  return false;
}

const LOGIN_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Mukana Sync</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1115;color:#e6e8ec;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
form{background:#171a21;border:1px solid #262b36;border-radius:10px;padding:24px;width:min(320px,calc(100vw - 32px))}
h1{font-size:16px;margin:0 0 16px}input{width:100%;box-sizing:border-box;background:#0f1115;color:#e6e8ec;border:1px solid #262b36;border-radius:6px;padding:10px;font:inherit}
button{margin-top:12px;width:100%;background:#3d8bfd;color:#fff;border:0;border-radius:6px;padding:10px;font:inherit;font-weight:600;cursor:pointer}
p{color:#ff5c5c;font-size:13px;min-height:1em;margin:10px 0 0}</style></head><body>
<form id="f"><h1>Mukana → mimoLive Sync</h1><input id="pw" type="password" placeholder="Password" autofocus autocomplete="current-password">
<button>Sign in</button><p id="e"></p></form>
<script>document.getElementById('f').onsubmit=async(ev)=>{ev.preventDefault();
const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
if(r.ok)location.href='/';else document.getElementById('e').textContent='Wrong password';};</script></body></html>`;

// UI may send a just-typed (unsaved) mimoLive password in a header; otherwise use the stored one.
const mlPassword = (req) => req.headers['x-ml-password'] || config.mimolive.password || '';

const routes = {
  'GET /api/config': () => publicConfig(config),
  'GET /api/fields': () => FIELDS,
  'GET /api/status': () => engine.status(),

  'POST /api/config': async (req) => {
    const patch = await readBody(req);
    if (patch.mukana && !patch.mukana.refreshToken) delete patch.mukana.refreshToken; // keep stored token
    if (patch.mukana?.refreshToken) patch.mukana.refreshToken = patch.mukana.refreshToken.trim();
    if (patch.mimolive && 'password' in patch.mimolive && patch.mimolive.password === undefined) delete patch.mimolive.password;
    if (patch.mimolive && patch.mimolive.password === '') delete patch.mimolive.password; // empty field = keep stored
    if (patch.mimolive?.clearPassword) { patch.mimolive.password = ''; delete patch.mimolive.clearPassword; }
    const before = JSON.stringify(config.mukana);
    config = updateConfig(config, patch);
    if (Array.isArray(patch.targets)) config.targets = patch.targets;
    saveConfig(config);
    if (engine.running && JSON.stringify(config.mukana) !== before) {
      engine.stop();
      await engine.start();
    } else if (engine.running) {
      await engine.push(true);
    }
    return publicConfig(config);
  },

  'POST /api/start': async () => {
    await engine.start();
    config.autoStart = true;
    saveConfig(config);
    return engine.status();
  },
  'POST /api/stop': async () => {
    engine.stop();
    config.autoStart = false;
    saveConfig(config);
    return engine.status();
  },
  'POST /api/push': async () => {
    await engine.push(true);
    return engine.status();
  },
  'POST /api/clear': async () => {
    await engine.clear();
    return engine.status();
  },

  // Read back every mapped target from mimoLive and compare with what the engine expects.
  'GET /api/mimolive/verify': async () => {
    const ml = new MimoLive(config.mimolive);
    const expected = engine.current.values;
    return Promise.all(
      config.targets.map(async (t) => {
        const want = expected[t.field] ?? '';
        try {
          const { name, values } = await ml.getInputs({ documentId: config.mimolive.documentId, kind: t.kind, id: t.id });
          const actual = values[t.key];
          return { field: t.field, target: name, key: t.key, expected: want, actual: actual ?? null, ok: String(actual ?? '') === String(want), keyExists: t.key in values };
        } catch (e) {
          return { field: t.field, target: t.id, key: t.key, expected: want, actual: null, ok: false, error: e.message };
        }
      })
    );
  },
  'GET /api/mimolive/discover': async (req, url) => discover(Number(url.searchParams.get('port') || 8989), { password: mlPassword(req) }),
  'GET /api/mimolive/documents': async (req, url) =>
    new MimoLive({ host: url.searchParams.get('host'), port: url.searchParams.get('port') || 8989, password: mlPassword(req) }).documents(),
  'GET /api/mimolive/elements': async (req, url) => {
    const ml = new MimoLive({ host: url.searchParams.get('host'), port: url.searchParams.get('port') || 8989, password: mlPassword(req) });
    const doc = url.searchParams.get('doc');
    const [layers, sources] = await Promise.all([ml.layers(doc), ml.sources(doc).catch(() => [])]);
    return { layers, sources };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const { password } = await readBody(req).catch(() => ({}));
    if (!UI_PASSWORD || !safeEqual(password ?? '', UI_PASSWORD)) {
      await new Promise((r) => setTimeout(r, 500)); // slow down guessing
      return send(res, 401, { error: 'Wrong password' });
    }
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.add(sid);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
    return send(res, 200, { ok: true });
  }
  if (!authorized(req)) {
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return send(res, 401, LOGIN_HTML, 'text/html; charset=utf-8');
    return send(res, 401, { error: 'Auth required' });
  }
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      return send(res, 200, await handler(req, url));
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }
  if (req.method === 'GET') {
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const full = path.join(PUBLIC, path.normalize(file));
    if (full.startsWith(PUBLIC) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(full)] || 'application/octet-stream';
      return send(res, 200, fs.readFileSync(full), `${type}; charset=utf-8`);
    }
  }
  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`Mukana → mimoLive Sync running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!UI_PASSWORD) console.log('Tip: set UI_PASSWORD to password-protect the web UI on the network.');
  if (config.autoStart && config.mukana.refreshToken && config.mukana.eventId) {
    engine.start().catch((e) => console.error('Autostart failed:', e.message));
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    engine.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

export { server, engine };
