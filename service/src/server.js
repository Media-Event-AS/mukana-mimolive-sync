// HTTP server: web UI + JSON API. Zero dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

function authorized(req) {
  if (!UI_PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString();
  const pass = decoded.slice(decoded.indexOf(':') + 1); // username is ignored; password may contain ':'
  return pass === UI_PASSWORD;
}

const routes = {
  'GET /api/config': () => publicConfig(config),
  'GET /api/fields': () => FIELDS,
  'GET /api/status': () => engine.status(),

  'POST /api/config': async (req) => {
    const patch = await readBody(req);
    if (patch.mukana && !patch.mukana.refreshToken) delete patch.mukana.refreshToken; // keep stored token
    if (patch.mukana?.refreshToken) patch.mukana.refreshToken = patch.mukana.refreshToken.trim();
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

  'GET /api/mimolive/discover': async (req, url) => discover(Number(url.searchParams.get('port') || 8989)),
  'GET /api/mimolive/documents': async (req, url) =>
    new MimoLive({ host: url.searchParams.get('host'), port: url.searchParams.get('port') || 8989 }).documents(),
  'GET /api/mimolive/elements': async (req, url) => {
    const ml = new MimoLive({ host: url.searchParams.get('host'), port: url.searchParams.get('port') || 8989 });
    const doc = url.searchParams.get('doc');
    const [layers, sources] = await Promise.all([ml.layers(doc), ml.sources(doc).catch(() => [])]);
    return { layers, sources };
  },
};

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Mukana Sync"' });
    return res.end('Auth required');
  }
  const url = new URL(req.url, 'http://x');
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
  console.log(`Mukana → mimoLive Sync kjører på http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!UI_PASSWORD) console.log('Tips: sett UI_PASSWORD for å beskytte web-UI-et på nettverket.');
  if (config.autoStart && config.mukana.refreshToken && config.mukana.eventId) {
    engine.start().catch((e) => console.error('Autostart feilet:', e.message));
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
