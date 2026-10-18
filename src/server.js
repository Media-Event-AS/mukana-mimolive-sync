// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Ronny Hofsøy, Media Event AS
// HTTP server: web UI + JSON API. Zero dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import os from 'node:os';
import { loadConfig, saveConfig, updateConfig, publicConfig, FIELDS } from './config.js';
import { SyncEngine } from './sync.js';
import { MimoLive, discover } from './mimolive.js';
import * as autostart from './autostart.js';
import { migrateRules, addPanelistCues, overlayLayersFrom, EVENTS, ACTIONS, SHOTS } from './cues.js';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const UI_PASSWORD = process.env.UI_PASSWORD || '';

let config = loadConfig();
// Layer control rules from before the cue list become cues.
if (config.layerControl.rules?.length && !config.layerControl.cues?.length) {
  config.layerControl.cues = migrateRules(config.layerControl.rules);
  delete config.layerControl.rules;
  saveConfig(config);
  console.log(`Layer control: converted the old rules to ${config.layerControl.cues.length} cues`);
}
// Listen address: env vars win (and lock the setting), otherwise the saved config.
const ENV_LOCK = { host: !!process.env.HOST, port: !!process.env.PORT };
let listenAddr = {
  host: process.env.HOST || config.server.host || '0.0.0.0',
  port: Number(process.env.PORT || config.server.port || 8790),
};

function localAddresses() {
  const list = [{ address: '0.0.0.0', label: 'All interfaces (LAN + this machine)' }, { address: '127.0.0.1', label: 'This machine only' }];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) list.push({ address: a.address, label: `${name} only` });
  }
  return list;
}

function listenOn(host, port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(handleRequest);
    s.once('error', reject);
    s.listen(port, host, () => {
      s.off('error', reject);
      resolve(s);
    });
  });
}

const engine = new SyncEngine(
  () => config,
  (newRefresh) => {
    config.mukana.refreshToken = newRefresh;
    saveConfig(config);
  }
);
engine.on('configChanged', () => saveConfig(config)); // e.g. the captured pre-flight list

/** Add the panelist cues to the cue list (the question overlay is worked out from the layer sets). */
async function addPanelistCuesNow() {
  const sets = await new MimoLive(config.mimolive).layerSets(config.mimolive.documentId);
  const cues = config.layerControl.cues || [];
  const overlayLayers = overlayLayersFrom({ cues, panelists: config.panelists, targets: config.targets, sets });
  config.layerControl.cues = addPanelistCues(cues, { panelists: config.panelists, overlayLayers });
  config.layerControl.panelistCuesAdded = true;
  saveConfig(config);
  engine.cues.configure();
  engine.addLog('info', `Cue list: added the panelist cues (${config.layerControl.cues.length - cues.length} new)`);
  return publicConfig(config);
}
// Panelists used to run by themselves; now the cue list runs them. Convert once.
if (config.panelists?.layouts?.length && !config.layerControl.panelistCuesAdded) {
  addPanelistCuesNow().catch((e) => console.error('Adding panelist cues failed:', e.message));
}

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

const pkg = createRequire(import.meta.url)('../package.json');

const routes = {
  'GET /api/config': () => publicConfig(config),
  'GET /api/fields': () => FIELDS,
  'GET /api/about': () => ({ name: 'Mukana → mimoLive Sync', version: pkg.version, author: pkg.author, homepage: pkg.homepage, bugs: pkg.bugs?.url }),
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
    for (const c of config.layerControl.cues || []) c.id ||= crypto.randomUUID();
    engine.cues.configure();
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
  // ---- cue list, Companion and simulation
  'GET /api/cues/meta': () => ({ events: EVENTS, actions: ACTIONS, shots: SHOTS }),
  'GET /api/cues': () => {
    const s = engine.status();
    return { autoLayers: s.autoLayers, simulating: s.simulating, questionLive: s.current.active, question: s.current.values.name, answering: s.current.answering.map((p) => p.name), shot: s.panelists.shot, answerShot: s.panelists.answerShot, cues: s.cues };
  },
  'POST /api/cues/add-panelist-cues': async () => addPanelistCuesNow(),
  'POST /api/cues/stop-all': async () => {
    engine.cues.stopAll();
    engine.addLog('info', 'Cue · all stopped');
    return engine.cues.status();
  },
  'POST /api/auto-layers': async (req) => {
    const body = await readBody(req);
    config.layerControl.enabled = typeof body.enabled === 'boolean' ? body.enabled : !config.layerControl.enabled;
    saveConfig(config);
    engine.cues.configure();
    engine.addLog('info', `Auto layers ${config.layerControl.enabled ? 'on' : 'off'}`);
    return { autoLayers: config.layerControl.enabled };
  },
  'POST /api/simulate/end': async () => engine.endSim(),
  'POST /api/panelists/roster/from-question': async () => engine.panelists.addFromCurrentQuestion(engine.trees),
  'POST /api/panelists/roster/clear': async () => {
    config.panelists.roster = { eventId: config.mukana.eventId, people: [] };
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

  'GET /api/server': () => ({ ...listenAddr, envLock: ENV_LOCK, addresses: localAddresses() }),
  'POST /api/server': async (req) => {
    const body = await readBody(req);
    const host = String(body.host ?? listenAddr.host).trim();
    const port = Number(body.port ?? listenAddr.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be 1–65535');
    if (!/^(\d{1,3}\.){3}\d{1,3}$|^::1?$|^[\w.-]+$/.test(host)) throw new Error('Invalid IP address');
    if ((ENV_LOCK.host && host !== listenAddr.host) || (ENV_LOCK.port && port !== listenAddr.port)) {
      throw new Error('Set by the HOST/PORT environment variable. Change it where the service is started.');
    }
    if (host === listenAddr.host && port === listenAddr.port) return { ...listenAddr, changed: false };
    let next;
    try {
      next = await listenOn(host, port); // bind the new address first; keep the old one if this fails
    } catch (e) {
      throw new Error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use on ${host}` : e.code === 'EADDRNOTAVAIL' ? `${host} is not an address of this machine` : e.message);
    }
    const old = server;
    server = next;
    listenAddr = { host, port };
    config.server = { host, port };
    saveConfig(config);
    console.log(`Now listening on http://${host}:${port}`);
    setTimeout(() => {
      old.close();
      old.closeAllConnections?.();
    }, 1500);
    return { ...listenAddr, changed: true };
  },

  'GET /api/autostart': () => autostart.status(),
  'POST /api/autostart/enable': async (req) => {
    const { now } = await readBody(req);
    const st = autostart.enable();
    if (now && !st.runningUnderLaunchd) {
      // Respond first, then exit and let launchd start the service in the background.
      setTimeout(() => {
        engine.stop();
        autostart.handoverToLaunchd((cb) => server.close(cb));
      }, 300);
      return { ...st, handover: true };
    }
    return st;
  },
  'POST /api/autostart/disable': async () => autostart.disable(),

  // Read back every mapped target from mimoLive and compare with what the engine expects.
  'GET /api/mimolive/verify': async () => {
    const ml = new MimoLive(config.mimolive);
    return Promise.all(
      config.targets.map(async (t) => {
        const want = engine.valueFor(t);
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
  'GET /api/mimolive/variants': async (req, url) =>
    new MimoLive({ ...config.mimolive, password: mlPassword(req) }).variants(config.mimolive.documentId, url.searchParams.get('layer')),
  'GET /api/mimolive/discover': async (req, url) => discover(Number(url.searchParams.get('port') || 8989), { password: mlPassword(req) }),
  'GET /api/mimolive/documents': async (req, url) =>
    new MimoLive({ host: url.searchParams.get('host'), port: url.searchParams.get('port') || 8989, password: mlPassword(req) }).documents(),
  'GET /api/mimolive/elements': async (req, url) => {
    const ml = new MimoLive({ host: url.searchParams.get('host'), port: url.searchParams.get('port') || 8989, password: mlPassword(req) });
    const doc = url.searchParams.get('doc');
    const [layers, sources, layerSets] = await Promise.all([ml.layers(doc), ml.sources(doc).catch(() => []), ml.layerSets(doc)]);
    return { layers, sources, layerSets };
  },
};

// Routes with a parameter: cue number or id, simulated event name.
const PARAM_ROUTES = [
  [/^POST \/api\/cues\/([^/]+)\/go$/, (req, url, ref) => engine.cues.go(ref)],
  [/^POST \/api\/cues\/([^/]+)\/stop$/, (req, url, ref) => engine.cues.stopCue(ref)],
  [/^POST \/api\/cues\/([^/]+)\/continue$/, (req, url, ref) => engine.cues.continueCue(ref, 'Companion')],
  [/^POST \/api\/shot\/(host|solo|hostOnly)$/, async (req, url, shot) => {
    const msg = await engine.panelists.changeShot(new MimoLive(config.mimolive), config.mimolive.documentId, shot);
    engine.addLog('info', `Shot ${SHOTS[shot]} (Companion): ${msg}`);
    return { shot: engine.panelists.shot, answerShot: engine.panelists.answerShot, message: msg };
  }],
  [/^POST \/api\/simulate\/([^/]+)$/, async (req, url, event) => engine.simulate(event, await readBody(req).catch(() => ({})))],
];

async function handleRequest(req, res) {
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
  let handler = routes[`${req.method} ${url.pathname}`];
  for (const [re, fn] of PARAM_ROUTES) {
    if (handler) break;
    const m = `${req.method} ${url.pathname}`.match(re);
    if (m) handler = (rq, u) => fn(rq, u, ...m.slice(1).map(decodeURIComponent));
  }
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
}

let server = await listenOn(listenAddr.host, listenAddr.port).catch((e) => {
  console.error(`Cannot listen on ${listenAddr.host}:${listenAddr.port}: ${e.code || e.message}. Start with PORT=… to use another port.`);
  process.exit(1);
});
{
  const { host: HOST, port: PORT } = listenAddr;
  console.log(`Mukana → mimoLive Sync running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!UI_PASSWORD) console.log('Tip: set UI_PASSWORD to password-protect the web UI on the network.');
  if (config.autoStart && config.mukana.refreshToken && config.mukana.eventId) {
    engine.start().catch((e) => console.error('Autostart failed:', e.message));
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    engine.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}

export { server, engine };
