// End-to-end test with mock securetoken, mock RTDB (SSE) and mock mimoLive.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { deriveFields, extractUrl, cleanText } from '../src/sync.js';
import { applyEvent } from '../src/firebase.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

// ---------- unit ----------
assert.deepEqual(extractUrl('Se https://example.com/a?b=1, takk'), { url: 'https://example.com/a?b=1', rest: 'Se, takk' });
assert.equal(cleanText('A &amp; B<br>C'), 'A & B\nC');
let tree = applyEvent(null, 'put', '/', { a: { b: 1 } });
tree = applyEvent(tree, 'patch', '/a', { c: 2 });
tree = applyEvent(tree, 'put', '/a/b', null);
assert.deepEqual(tree, { a: { c: 2 } });
const d = deriveFields(
  { key: 'Q1', n: 'Kari', q: 'Hva nå? https://x.no/y', l: 'Tromsø', tag: 'Klima', v: 3 },
  { Q1: { array: [{ uid: 'u1', st: 'a', name: 'Ola' }, { uid: 'u2', st: 'q' }, { uid: 'u3', st: 'q', name: 'Per' }] } },
  { u2: { displayName: 'Anne' } }
);
assert.equal(d.values.question, 'Hva nå?');
assert.equal(d.values.url, 'https://x.no/y');
assert.equal(d.values.queue, '2. Anne, 3. Per');
assert.equal(d.values.activePanelist, 'Ola');
assert.equal(deriveFields(null).active, false);
const host = {
  Q1: { displayName: 'Kari', comment: 'x', source: 'form', hostNotes: 'Ask about <b>budget</b>', namePho: 'KAH-ree', locPho: 'TROMS-uh', ts_answered: Date.UTC(2026, 0, 1, 12, 5), status: 'answering', orderID: 1 },
  Q2: { displayName: 'Nils', comment: 'Second question', orderID: 3, status: 'active' },
  Q3: { displayName: 'Siri', comment: 'Next up https://x.no', orderID: 2, city: 'Bodø', tag: 'Tech' },
  Q4: { displayName: 'Gone', comment: 'removed', orderID: 0, ts_removed: 1 },
};
const d2 = deriveFields({ key: 'Q1', n: 'Kari', q: 'Hei', loc_cc: 'no', v: -5, rd: true }, null, { a: {}, b: {} }, host, { s1: {}, s2: {}, s3: { ts_removed: 5 } }, { a1: {} });
assert.equal(d2.values.countryFlag, '🇳🇴');
assert.equal(d2.values.countryCode, 'NO');
assert.equal(d2.values.votes, '5');
assert.equal(d2.values.notes, 'Ask about budget');
assert.equal(d2.values.source, 'form');
assert.equal(d2.values.sourceLabel, 'QR form');
assert.equal(d2.values.namePhonetic, 'KAH-ree');
assert.equal(d2.values.doneReading, 'yes');
assert.match(d2.values.answeringSince, /^\d\d:\d\d$/);
assert.equal(d2.values.onDeckCount, '3');
assert.equal(d2.values.nextName, 'Siri');
assert.equal(d2.values.nextLocation, 'Bodø');
assert.equal(d2.values.nextTag, 'Tech');
assert.equal(d2.values.nextQuestion, 'Next up');
assert.equal(d2.values.nextQuestionFull, 'Next up https://x.no');
assert.equal(d2.values.votingCount, '2');
assert.equal(d2.values.answeredCount, '1');
assert.equal(d2.values.panelistsOnline, '2');
const d3 = deriveFields(null, null, null, host);
assert.equal(d3.values.name, '');
assert.equal(d3.values.nextName, 'Siri', 'rundown available without live question');
// mimoLive password auth (SHA-256 hex header)
{
  const { MimoLive, MimoLiveAuthError, discover } = await import('../src/mimolive.js');
  const crypto = await import('node:crypto');
  const want = crypto.createHash('sha256').update('s3cret').digest('hex');
  const pwSrv = http.createServer((req, res) => {
    if (req.headers['x-mimolive-password-sha256'] !== want) { res.statusCode = 401; return res.end('{}'); }
    res.end(JSON.stringify({ data: [{ id: '1', attributes: { name: 'Doc' } }] }));
  });
  const pwPort = await listen(pwSrv);
  assert.equal((await new MimoLive({ host: '127.0.0.1', port: pwPort, password: 's3cret' }).documents())[0].name, 'Doc');
  await assert.rejects(new MimoLive({ host: '127.0.0.1', port: pwPort }).documents(), MimoLiveAuthError);
  const found = await discover(pwPort);
  assert.ok(found.some((f) => f.host === '127.0.0.1' && f.needsPassword));
  pwSrv.close();
}
// autostart plist
{
  const { buildPlist, LABEL } = await import('../src/autostart.js');
  const x = buildPlist({ node: '/opt/homebrew/bin/node', server: '/a b/src/server.js', cwd: '/a b', env: { PORT: '8790', UI_PASSWORD: 'p<&>' }, log: '/tmp/l.log' });
  assert.match(x, new RegExp(`<string>${LABEL}</string>`));
  assert.match(x, /<string>\/a b\/src\/server\.js<\/string>/);
  assert.match(x, /<key>UI_PASSWORD<\/key><string>p&lt;&amp;&gt;<\/string>/);
  assert.match(x, /<key>MMS_LAUNCHD<\/key><string>1<\/string>/);
  assert.match(x, /<key>KeepAlive<\/key><true\/>/);
}
console.log('✓ unit');

// ---------- mocks ----------
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = `${b64({ alg: 'none' })}.${b64({ user_id: 'uid123', email: 'test@mediaevent.no' })}.sig`;
let tokenCalls = 0;
const secure = http.createServer((req, res) => {
  tokenCalls++;
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const ok = new URLSearchParams(body).get('refresh_token') === 'RT-good';
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { id_token: idToken, refresh_token: 'RT-good', expires_in: '3600', user_id: 'uid123' } : { error: { message: 'INVALID_REFRESH_TOKEN' } }));
  });
});

const sseClients = {}; // path -> res
const rtdb = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.searchParams.get('auth') !== idToken) {
    res.writeHead(401);
    return res.end('{"error":"Permission denied"}');
  }
  const p = u.pathname.replace(/\.json$/, '').replace(/^\//, '');
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  sseClients[p] = res;
  res.write(`event: put\ndata: ${JSON.stringify({ path: '/', data: null })}\n\n`);
});
const sse = (p, type, pth, data) => sseClients[p]?.write(`event: ${type}\ndata: ${JSON.stringify({ path: pth, data })}\n\n`);

const mimoCalls = [];
const mimoState = {}; // id -> input-values
const mimo = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const elId = u.pathname.match(/\/(?:layers|sources)\/([^/]+)$/)?.[1];
  if (elId && !u.searchParams.has('update')) return res.end(JSON.stringify({ data: { id: elId, attributes: { name: 'El ' + elId, 'input-values': mimoState[elId] || {} } } }));
  res.setHeader('Content-Type', 'application/vnd.api+json');
  if (u.pathname === '/api/v1/documents') return res.end(JSON.stringify({ data: [{ id: '1185605207', type: 'documents', attributes: { name: 'Show.tvshow' } }] }));
  if (u.pathname.endsWith('/layers') && !u.searchParams.has('update'))
    return res.end(JSON.stringify({ data: [{ id: 'L-NAME', attributes: { name: 'Lower Third', 'input-values': { tvGroup_Content__Text_TypeMultiline: '' } } }] }));
  if (u.pathname.endsWith('/sources') && !u.searchParams.has('update'))
    return res.end(JSON.stringify({ data: [{ id: 'S-QR', attributes: { name: 'QR', 'input-values': { tvGroup_Content__QR_Content: '' } } }] }));
  if (u.searchParams.has('update')) {
    const upd = JSON.parse(u.searchParams.get('update'));
    mimoCalls.push({ path: u.pathname, update: upd });
    if (elId) mimoState[elId] = { ...(mimoState[elId] || {}), ...upd['input-values'] };
    return res.end('{"data":{}}');
  }
  res.statusCode = 404;
  res.end('{}');
});

const [securePort, rtdbPort, mimoPort] = await Promise.all([listen(secure), listen(rtdb), listen(mimo)]);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mms-'));
const appPort = 18790 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, [path.join(here, '..', 'src', 'server.js')], {
  env: { ...process.env, PORT: String(appPort), HOST: '127.0.0.1', DATA_DIR: dataDir, SECURETOKEN_URL: `http://127.0.0.1:${securePort}/v1/token` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childOut = '';
child.stdout.on('data', (c) => (childOut += c));
child.stderr.on('data', (c) => (childOut += c));
const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${appPort}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
const waitFor = async (fn, label, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error(`timeout: ${label}\n${childOut}`);
};

try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${appPort}/api/status`).catch(() => null))?.ok, 'server up');

  // autostart API (non-macOS in CI → unsupported, enable refused)
  const as = await api('GET', '/api/autostart');
  assert.equal(as.json.supported, process.platform === 'darwin');
  if (process.platform !== 'darwin') assert.equal((await api('POST', '/api/autostart/enable', {})).status, 400);

  // UI served
  const html = await (await fetch(`http://127.0.0.1:${appPort}/`)).text();
  assert.match(html, /Mukana → mimoLive Sync/);
  assert.match(html, /manual\.html/);
  const manual = await fetch(`http://127.0.0.1:${appPort}/manual.html`);
  assert.equal(manual.status, 200);
  assert.match(await manual.text(), /Troubleshooting/);

  // mimoLive endpoints via proxy
  const docs = await api('GET', `/api/mimolive/documents?host=127.0.0.1&port=${mimoPort}`);
  assert.equal(docs.json[0].name, 'Show.tvshow');
  const els = await api('GET', `/api/mimolive/elements?host=127.0.0.1&port=${mimoPort}&doc=1185605207`);
  assert.equal(els.json.layers[0].inputKeys[0], 'tvGroup_Content__Text_TypeMultiline');
  assert.equal(els.json.sources[0].id, 'S-QR');

  // bad token is rejected cleanly
  await api('POST', '/api/config', { mukana: { eventId: 'ohtest', refreshToken: 'RT-bad', databaseURL: `http://127.0.0.1:${rtdbPort}` } });
  const bad = await api('POST', '/api/start');
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /INVALID_REFRESH_TOKEN/);

  // config never leaks token
  const cfg = await api('POST', '/api/config', {
    mukana: { refreshToken: 'RT-good' },
    mimolive: { host: '127.0.0.1', port: mimoPort, documentId: '1185605207' },
    targets: [
      { field: 'name', kind: 'layer', id: 'L-NAME', key: 'tvGroup_Content__Text_TypeMultiline' },
      { field: 'question', kind: 'layer', id: 'L-TEXT', key: 'tvGroup_Content__Text_TypeMultiline' },
      { field: 'queue', kind: 'layer', id: 'L-QUEUE', key: 'tvGroup_Note__Note_TypeMultiline' },
      { field: 'url', kind: 'source', id: 'S-QR', key: 'tvGroup_Content__QR_Content' },
    ],
  });
  assert.equal(cfg.json.mukana.refreshToken, undefined);
  assert.equal(cfg.json.mukana.hasRefreshToken, true);
  const pwCfg = await api('POST', '/api/config', { mimolive: { password: 'pw1' } });
  assert.equal(pwCfg.json.mimolive.password, undefined);
  assert.equal(pwCfg.json.mimolive.hasPassword, true);
  const keep = await api('POST', '/api/config', { mimolive: { password: '' } });
  assert.equal(keep.json.mimolive.hasPassword, true, 'empty field keeps stored password');
  const cleared = await api('POST', '/api/config', { mimolive: { clearPassword: true } });
  assert.equal(cleared.json.mimolive.hasPassword, false);

  const st = await api('POST', '/api/start');
  assert.equal(st.status, 200, JSON.stringify(st.json));
  await waitFor(() => sseClients['qs_liveQ/ohtest'] && sseClients['panel_hands/ohtest'], 'streams connected');
  await waitFor(async () => Object.values((await api('GET', '/api/status')).json.streams).every((s) => s === 'live'), 'streams live');

  // question goes live
  mimoCalls.length = 0;
  sse('panel_hands/ohtest', 'put', '/', { Q1: { array: [{ uid: 'u1', st: 'q', name: 'Ola Panel' }] } });
  sse('qs_liveQ/ohtest', 'put', '/', { key: 'Q1', n: 'Kari', q: 'Hva med nordlyset? https://nordlys.no/x', l: 'Tromsø', tag: 'Natur', v: 4 });
  await waitFor(() => mimoCalls.length >= 4, 'first push');
  const byLayer = (id) => mimoCalls.filter((c) => c.path.endsWith(id)).at(-1)?.update['input-values'];
  assert.equal(byLayer('L-NAME').tvGroup_Content__Text_TypeMultiline, 'Kari');
  assert.equal(byLayer('L-TEXT').tvGroup_Content__Text_TypeMultiline, 'Hva med nordlyset?');
  assert.equal(byLayer('L-QUEUE').tvGroup_Note__Note_TypeMultiline, '1. Ola Panel');
  assert.equal(byLayer('S-QR').tvGroup_Content__QR_Content, 'https://nordlys.no/x');
  assert.ok(mimoCalls.find((c) => c.path === '/api/v1/documents/1185605207/sources/S-QR'));

  // verify endpoint reads back from mimoLive
  const ver = await api('GET', '/api/mimolive/verify');
  assert.equal(ver.json.length, 4);
  assert.ok(ver.json.every((r) => r.ok), JSON.stringify(ver.json));
  const st2 = await api('GET', '/api/status');
  assert.equal(st2.json.current.values.votes, '4');

  // only changed fields are re-sent (patch votes -> nothing mapped changes)
  mimoCalls.length = 0;
  sse('qs_liveQ/ohtest', 'patch', '/', { v: 9 });
  await sleep(300);
  assert.equal(mimoCalls.length, 0, 'no resend for unmapped change');

  // queue change via patch
  sse('panel_hands/ohtest', 'put', '/Q1/array/1', { uid: 'u9', st: 'q', name: 'Per' });
  await waitFor(() => mimoCalls.length === 1, 'queue update');
  assert.equal(byLayer('L-QUEUE').tvGroup_Note__Note_TypeMultiline, '1. Ola Panel, 2. Per');

  // question removed -> clear all
  mimoCalls.length = 0;
  sse('qs_liveQ/ohtest', 'put', '/', null);
  await waitFor(() => mimoCalls.length >= 4, 'clear');
  assert.ok(mimoCalls.every((c) => Object.values(c.update['input-values'])[0] === ''));

  // force push re-sends everything
  mimoCalls.length = 0;
  await api('POST', '/api/push');
  assert.equal(mimoCalls.length, 4);

  // stop
  const stopped = await api('POST', '/api/stop');
  assert.equal(stopped.json.running, false);
  assert.ok(!fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8').includes('"autoStart": true'));
  console.log('✓ e2e');
} finally {
  child.kill();
  secure.close();
  rtdb.closeAllConnections?.();
  rtdb.close();
  mimo.close();
}
console.log('All tests passed');
process.exit(0);
