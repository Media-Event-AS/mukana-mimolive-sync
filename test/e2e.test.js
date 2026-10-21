// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Ronny Hofsøy, Media Event AS
// End-to-end test with mock securetoken, mock RTDB (SSE) and mock mimoLive.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { deriveFields, extractUrl, cleanText, onlinePanelists, handsPeople, findQuestions } from '../src/sync.js';
import { detectEvents, migrateRules, addPanelistCues } from '../src/cues.js';
import { applyShow, slug } from '../src/profiles.js';
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
// online list: `online` flag decides (ts_off can be stale), hosts excluded
assert.deepEqual(onlinePanelists({ a: { displayName: 'A', online: true, ts_off: 5, loc: 'Oslo' }, b: { displayName: 'B', online: false }, h: { displayName: 'Host', online: true, host: true }, c: { displayName: 'C' } }), [{ uid: 'a', name: 'A', loc: 'Oslo' }, { uid: 'c', name: 'C', loc: '' }]);
// both hands formats
// location from the hand, else from the online list
assert.deepEqual(handsPeople({ array: [{ uid: 'u1', name: 'Ola', st: 'q', loc: 'Tromsø' }, null, { uid: 'u2', st: 'a' }] }, { u2: { displayName: 'Per', loc: 'Bodø' } }), [{ uid: 'u1', name: 'Ola', loc: 'Tromsø' }, { uid: 'u2', name: 'Per', loc: 'Bodø' }]);
assert.deepEqual(handsPeople({ u3: true }, { u3: { displayName: 'Anne' } }), [{ uid: 'u3', name: 'Anne', loc: '' }]);
assert.deepEqual(findQuestions({ liveQ: null, hostOutput: { k1: { comment: 'x' } }, answered: { k2: { comment: '***Pre-flight checklist item: raise hands*' } } }, 'pre-flight CHECKLIST'), ['k2']);
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
// Mukana events
{
  const base = deriveFields({ key: 'Q1', n: 'A', q: 'x' }, { Q1: { u9: true, array: [{ uid: 'u1', st: 'q' }] } }, {}, { Q1: {} });
  assert.deepEqual(base.raised, ['u9']);
  assert.deepEqual(base.queued, ['u1']);
  assert.deepEqual(base.panel.map((p) => p.uid), ['u1'], 'panel = above the line (not the raised hand below it)');
  const next = deriveFields({ key: 'Q1', n: 'A', q: 'x', rd: true }, { Q1: { u9: true, u8: true, array: [{ uid: 'u1', st: 'a' }, { uid: 'u7', st: 'q' }] } }, {}, { Q1: { hostNotes: 'Note' } });
  assert.deepEqual(detectEvents(base, next).sort(), ['aboveLine', 'answeringChange', 'answeringStart', 'doneReading', 'handRaised', 'hostNotes']);
  const stop = deriveFields({ key: 'Q1', n: 'A', q: 'x', rd: true }, { Q1: { array: [{ uid: 'u1', st: 'c' }] } }, {}, { Q1: { hostNotes: 'Note' } });
  assert.deepEqual(detectEvents(next, stop), ['answeringChange', 'answeringEnd']);
  // roles: the host answering does not count
  const hostOnly = { ...next, countable: [] };
  assert.ok(!detectEvents(base, hostOnly).includes('answeringStart'), 'host does not count');
  assert.deepEqual(detectEvents(next, deriveFields(null)), ['questionDone', 'answeringChange', 'answeringEnd'], 'question ends while answering');
  assert.deepEqual(detectEvents(deriveFields(null), base), ['questionLive'], 'a new question with hands up fires no hand events');
  assert.deepEqual(detectEvents(base, deriveFields({ key: 'Q2', n: 'B', q: 'y' })), ['questionLive', 'questionNext']);
  assert.deepEqual(detectEvents(base, deriveFields(null)), ['questionDone']);
  // old rules → cues
  const m = migrateRules([{ trigger: 'question', action: 'layerSet', onSetId: 'ON', offSetId: 'OFF', offAfterSec: 12, label: 'Q' }]);
  assert.deepEqual(m.map((c) => [c.name, c.trigger.event || c.trigger.type, c.preWait, c.action.type, c.action.setId, c.continue]), [
    ['Q on', 'questionLive', 0, 'recallSet', 'ON', 'auto-follow'],
    ['Q auto-off', 'none', 12, 'recallSet', 'OFF', 'none'],
    ['Q done', 'questionDone', 0, 'recallSet', 'OFF', 'none'],
  ]);
  assert.deepEqual(m[2].cancels, [m[0].id, m[1].id]);
  // default panelist cues: one timeline per panelist + shot buttons
  const pc = addPanelistCues([], { panelists: { ltLayerId: 'LT', ltDelaySec: 3, ltOffAfterSec: 8, layouts: [{ count: 1, layerId: 'L2', setId: 'S2', slots: ['B'] }, { count: 1, shot: 'solo', layerId: 'LF', setId: 'SF', slots: ['A'] }, { count: 0, shot: 'hostOnly', setId: 'SH' }] } });
  assert.deepEqual(pc.map((c) => [c.name, c.preWait, c.continue]), [
    ['Reader into B', 0, 'none'],
    ['Answering · with host', 0, 'auto-continue'],
    ['Panelist name', 3, 'auto-continue'],
    ['Go single', 6, 'auto-continue'],
    ['Panelist name off', 11, 'none'],
    ['Panelists done', 0, 'none'],
    ['Shot: with host', 0, 'none'],
    ['Shot: answering only', 0, 'none'],
    ['Shot: host only', 0, 'none'],
  ]);
}
// profiles: the profile's token is used; without one the current login is kept
{
  const base = () => ({ mukana: { eventId: 'x', refreshToken: 'RT-now' }, mimolive: { host: 'h', port: 8989, documentId: 'd', password: 'pw' }, targets: [1], layerControl: { enabled: true, cues: [1] }, panelists: {} });
  const a = applyShow(base(), { mukana: { eventId: 'ev2', refreshToken: 'RT-show' }, targets: [] }, 'S');
  assert.deepEqual([a.mukana.eventId, a.mukana.refreshToken, a.mimolive.password, a.layerControl.enabled, a.profile], ['ev2', 'RT-show', 'pw', false, 'S']);
  assert.equal(applyShow(base(), { mukana: { eventId: 'ev3' } }).mukana.refreshToken, 'RT-now', 'no token in the profile: keep the login');
  assert.equal(slug('Rabalder 2026 – dag 1 (Tromsø)'), 'rabalder-2026-dag-1-tromso');
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
const mimoLive = {}; // layer id -> live-state
const mimoEvents = []; // ordered log of updates and live/off actions
const OUT_MS = 300; // mock out-transition
const goOff = (id) => {
  if (mimoLive[id] !== 'live') return;
  mimoLive[id] = 'shutdown';
  setTimeout(() => { mimoLive[id] = 'off'; mimoEvents.push({ t: Date.now(), type: 'isOff', id }); }, OUT_MS);
};
const LAYER_SETS = {
  // L-BG is live in both sets (like a background): it must never be switched off or waited for
  'SET-ON': { name: 'Question on', layers: [{ 'layer-id': 'L-SET', action: 'live' }, { 'layer-id': 'L-BG', action: 'live' }] },
  'SET-OFF': { name: 'Question off', layers: [{ 'layer-id': 'L-SET', action: 'off' }, { 'layer-id': 'L-BG', action: 'live' }] },
  'SET-2UP': { name: '2 UP', layers: [{ 'layer-id': 'L-2UP', action: 'live' }, { 'layer-id': 'L-3UP', action: 'off' }] },
  'SET-3UP': { name: '3 UP', layers: [{ 'layer-id': 'L-3UP', action: 'live' }, { 'layer-id': 'L-2UP', action: 'off' }] },
  'SET-FULL': { name: 'Fullscreen 2', layers: [{ 'layer-id': 'L-FULL', action: 'live' }] },
  'SET-HOST': { name: 'Fullscreen 1', layers: [{ 'layer-id': 'L-HOSTCAM', action: 'live' }] },
};
let mimoPassword = null; // when set, the mock mimoLive requires this password
const mimo = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (mimoPassword && req.headers['x-mimolive-password-sha256'] !== crypto.createHash('sha256').update(mimoPassword).digest('hex')) {
    res.statusCode = 401;
    return res.end('{}');
  }
  const vact = u.pathname.match(/\/layers\/([^/]+)\/variants\/([^/]+)\/setLive$/);
  if (vact) {
    mimoEvents.push({ t: Date.now(), type: 'vlive', id: vact[2] });
    mimoLive[vact[1]] = 'live';
    return res.end('{"data":{}}');
  }
  if (u.pathname.endsWith('/variants'))
    return res.end(JSON.stringify({ data: ['V-OLA', 'V-PER', 'V-ANNE'].map((id) => ({ id, type: 'variants', attributes: { name: id } })) }));
  const act = u.pathname.match(/\/layers\/([^/]+)\/(setLive|setOff)$/);
  if (act) {
    const [, id, a] = act;
    mimoEvents.push({ t: Date.now(), type: a === 'setLive' ? 'live' : 'off', id });
    if (a === 'setLive') mimoLive[id] = 'live';
    else goOff(id);
    return res.end('{"data":{}}');
  }
  if (u.pathname.endsWith('/layer-sets'))
    return res.end(JSON.stringify({ data: Object.entries(LAYER_SETS).map(([id, x]) => ({ id, type: 'layer-sets', attributes: x })) }));
  const sig = u.pathname.match(/\/layers\/([^/]+)\/signals\/([^/]+)$/);
  if (sig) {
    mimoEvents.push({ t: Date.now(), type: 'signal', id: sig[1], value: sig[2] });
    return res.end('{"data":{}}');
  }
  const recall = u.pathname.match(/\/layer-sets\/([^/]+)\/recall$/);
  if (recall) {
    mimoEvents.push({ t: Date.now(), type: 'recall', id: recall[1] });
    for (const l of LAYER_SETS[recall[1]].layers) l.action === 'live' ? (mimoLive[l['layer-id']] = 'live') : goOff(l['layer-id']);
    return res.end('{"data":{}}');
  }
  const elId = u.pathname.match(/\/(?:layers|sources)\/([^/]+)$/)?.[1];
  if (elId && !u.searchParams.has('update')) return res.end(JSON.stringify({ data: { id: elId, attributes: { name: 'El ' + elId, 'live-state': mimoLive[elId] || 'off', 'input-values': mimoState[elId] || {} } } }));
  res.setHeader('Content-Type', 'application/vnd.api+json');
  if (u.pathname === '/api/v1/documents') return res.end(JSON.stringify({ data: [{ id: '1185605207', type: 'documents', attributes: { name: 'Show.tvshow' } }] }));
  if (u.pathname.endsWith('/layers') && !u.searchParams.has('update'))
    return res.end(JSON.stringify({ data: [{ id: 'L-NAME', attributes: { name: 'Lower Third', 'input-values': { tvGroup_Content__Text_TypeMultiline: '' } } }] }));
  if (u.pathname.endsWith('/sources') && !u.searchParams.has('update'))
    return res.end(JSON.stringify({ data: [{ id: 'S-QR', attributes: { name: 'QR', 'input-values': { tvGroup_Content__QR_Content: '' } } }] }));
  if (u.searchParams.has('update')) {
    const upd = JSON.parse(u.searchParams.get('update'));
    mimoCalls.push({ path: u.pathname, update: upd });
    mimoEvents.push({ t: Date.now(), type: 'update', id: elId, key: Object.keys(upd['input-values'])[0], value: Object.values(upd['input-values'])[0] });
    if (elId) mimoState[elId] = { ...(mimoState[elId] || {}), ...upd['input-values'] };
    return res.end('{"data":{}}');
  }
  res.statusCode = 404;
  res.end('{}');
});

const [securePort, rtdbPort, mimoPort] = await Promise.all([listen(secure), listen(rtdb), listen(mimo)]);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mms-'));
const appPort = 18790 + Math.floor(Math.random() * 1000);
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ server: { host: '127.0.0.1', port: appPort } }));
const child = spawn(process.execPath, [path.join(here, '..', 'src', 'server.js')], {
  env: { ...process.env, PORT: '', HOST: '', DATA_DIR: dataDir, SECURETOKEN_URL: `http://127.0.0.1:${securePort}/v1/token`, MIMO_HEALTH_MS: '300' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childOut = '';
child.stdout.on('data', (c) => (childOut += c));
child.stderr.on('data', (c) => (childOut += c));
let appPortMoved = null;
const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${appPortMoved || appPort}${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
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
  assert.ok(cfg.json.mukana, JSON.stringify(cfg.json));
  assert.equal(cfg.json.mukana.refreshToken, undefined);
  assert.equal(cfg.json.mukana.hasRefreshToken, true);
  const pwCfg = await api('POST', '/api/config', { mimolive: { password: 'pw1' } });
  assert.equal(pwCfg.json.mimolive.password, undefined);
  assert.equal(pwCfg.json.mimolive.hasPassword, true);
  const keep = await api('POST', '/api/config', { mimolive: { password: '' } });
  assert.equal(keep.json.mimolive.hasPassword, true, 'empty field keeps stored password');
  const cleared = await api('POST', '/api/config', { mimolive: { clearPassword: true } });
  assert.equal(cleared.json.mimolive.hasPassword, false);

  // status light: mimoLive reachable with the document open / document not open / not reachable
  const mimoState = async () => (await api('GET', '/api/status')).json.mimolive;
  await waitFor(async () => (await mimoState()).state === 'ok', 'mimoLive ok');
  assert.match((await mimoState()).message, /Show\.tvshow/);
  await api('POST', '/api/config', { mimolive: { documentId: '999' } });
  await waitFor(async () => (await mimoState()).state === 'nodoc', 'document not open');
  await api('POST', '/api/config', { mimolive: { port: 1 } });
  await waitFor(async () => (await mimoState()).state === 'error', 'not reachable', 8000);
  assert.match((await mimoState()).message, /Not reachable/);
  await api('POST', '/api/config', { mimolive: { port: mimoPort, documentId: '1185605207' } });
  await waitFor(async () => (await mimoState()).state === 'ok', 'mimoLive ok again');
  // password: required but none saved / saved but wrong / right
  mimoPassword = 'show-pw';
  await waitFor(async () => (await mimoState()).state === 'auth', 'password required');
  assert.match((await mimoState()).message, /requires a password/);
  await api('POST', '/api/config', { mimolive: { password: 'wrong' } });
  await waitFor(async () => /password is wrong/.test((await mimoState()).message), 'wrong password');
  await api('POST', '/api/config', { mimolive: { password: 'show-pw' } });
  await waitFor(async () => (await mimoState()).state === 'ok', 'right password');
  mimoPassword = null;
  await api('POST', '/api/config', { mimolive: { clearPassword: true } });

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

  // ---------- automatic layer control ----------
  const TXT = 'tvGroup_Content__Text_TypeMultiline';
  const targets = (await api('GET', '/api/config')).json.targets;
  const lcTargets = [...targets, { field: 'name', kind: 'layer', id: 'L-LT', key: TXT }, { field: 'name', kind: 'layer', id: 'L-SET', key: TXT }];
  const ev = (type, id, value) => mimoEvents.findIndex((e) => e.type === type && e.id === id && (value === undefined || e.value === value));
  const evAt = (type, id, value) => mimoEvents[ev(type, id, value)];
  const els2 = await api('GET', `/api/mimolive/elements?host=127.0.0.1&port=${mimoPort}&doc=1185605207`);
  assert.equal(els2.json.layerSets.length, 6);
  assert.deepEqual(els2.json.layerSets[0].layers, [{ id: 'L-SET', action: 'live' }, { id: 'L-BG', action: 'live' }]);

  const cueCfg = (cues, enabled = true) => api('POST', '/api/config', { layerControl: { enabled, cues } });
  const mk = (id, name, trigger, action, more = {}) => ({ id, name, trigger: typeof trigger === 'string' ? { type: 'mukana', event: trigger } : trigger, preWait: 0, action, continue: 'none', cancels: [], ...more });

  // ---- question cues: text first, then live
  await api('POST', '/api/config', { targets: lcTargets });
  const c1 = await cueCfg([mk('c1', 'LT on', 'questionLive', { type: 'layerLive', layerId: 'L-LT' }), mk('c2', 'LT done', 'questionDone', { type: 'layerOff', layerId: 'L-LT' })]);
  assert.equal(c1.json.layerControl.cues.length, 2);
  mimoEvents.length = 0;
  sse('qs_liveQ/ohtest', 'put', '/', { key: 'Q1', n: 'Kari', q: 'Første', v: 1 });
  await waitFor(() => ev('live', 'L-LT') >= 0, 'layer live');
  assert.ok(ev('update', 'L-LT', 'Kari') >= 0 && ev('update', 'L-LT', 'Kari') < ev('live', 'L-LT'), 'text before live');

  // next question: the cue's layer goes out, gets the new text, comes back
  mimoEvents.length = 0;
  sse('qs_liveQ/ohtest', 'put', '/', { key: 'Q2', n: 'Nils', q: 'Andre', v: 1 });
  await waitFor(() => ev('live', 'L-LT') >= 0, 'layer live again');
  assert.ok(ev('off', 'L-LT') >= 0, 'went off first');
  assert.equal(ev('update', 'L-LT', ''), -1, 'never blanked during swap');
  assert.ok(evAt('update', 'L-LT', 'Nils').t >= evAt('isOff', 'L-LT').t, 'new text only after the layer is off');
  assert.ok(ev('update', 'L-NAME', 'Nils') >= 0 && ev('update', 'L-NAME', 'Nils') < ev('isOff', 'L-LT'), 'layers no cue took live update at once');

  // done / cancelled: off, wait, then clear
  mimoEvents.length = 0;
  sse('qs_liveQ/ohtest', 'put', '/', null);
  await waitFor(() => ev('update', 'L-LT', '') >= 0, 'text cleared');
  assert.ok(evAt('update', 'L-LT', '').t >= evAt('isOff', 'L-LT').t, 'cleared only after off');

  // operator takes the layer off by hand: a change in the same question does not bring it back
  sse('qs_liveQ/ohtest', 'put', '/', { key: 'Q3', n: 'Siv', q: 'Tredje', v: 1 });
  await waitFor(() => mimoLive['L-LT'] === 'live', 'Q3 live');
  mimoLive['L-LT'] = 'off';
  mimoEvents.length = 0;
  sse('qs_liveQ/ohtest', 'patch', '/', { v: 7, n: 'Siv Elin' });
  await waitFor(() => ev('update', 'L-LT', 'Siv Elin') >= 0, 'live text update');
  await sleep(200);
  assert.ok(!mimoEvents.some((e) => ['live', 'off'].includes(e.type)), 'manual off is respected');
  sse('qs_liveQ/ohtest', 'put', '/', null);
  await sleep(300);

  // ---- chains: auto-follow with pre-wait, cancels, auto-continue, GO, stop
  await cueCfg([
    mk('a', 'Set on', 'questionLive', { type: 'recallSet', setId: 'SET-ON' }, { continue: 'auto-follow' }),
    mk('b', 'Back', { type: 'none' }, { type: 'recallSet', setId: 'SET-OFF' }, { preWait: 1 }),
    mk('c', 'Done', 'questionDone', { type: 'recallSet', setId: 'SET-OFF' }, { cancels: ['a', 'b'] }),
    mk('d', 'Pair A', { type: 'go' }, { type: 'layerLive', layerId: 'L-X' }, { continue: 'auto-continue' }),
    mk('e', 'Pair B', { type: 'none' }, { type: 'layerLive', layerId: 'L-Y' }, { continue: 'auto-follow' }),
    mk('f', 'Hold', { type: 'none' }, { type: 'wait', seconds: 0.3 }, { continue: 'auto-follow' }),
    mk('g', 'Signal', { type: 'none' }, { type: 'signal', layerId: 'L-Y', signalId: 'tvGroup_Control__Go_TypeSignal' }),
    mk('h', 'Text', { type: 'go' }, { type: 'writeText', kind: 'layer', targetId: 'L-Y', key: TXT, value: 'Hi {name}' }),
  ]);
  mimoEvents.length = 0;
  sse('qs_liveQ/ohtest', 'put', '/', { key: 'Q4', n: 'Tor', q: 'Fjerde', v: 1 });
  await waitFor(() => ev('recall', 'SET-ON') >= 0, 'set on');
  const run1 = (await api('GET', '/api/cues')).json;
  assert.equal(run1.questionLive, true);
  assert.equal(run1.cues[1].phase, 'waiting', 'cue 2 in its pre-wait');
  assert.ok(run1.cues[1].endsAt > Date.now());
  await waitFor(() => ev('recall', 'SET-OFF') >= 0, 'auto-follow after pre-wait', 2500);
  assert.ok(evAt('recall', 'SET-OFF').t - evAt('recall', 'SET-ON').t >= 900, 'pre-wait respected');
  assert.ok(evAt('update', 'L-SET', 'Tor').t <= evAt('recall', 'SET-ON').t, 'question text before the set');
  // question done before the pre-wait ends: "Done" cancels "Back"
  sse('qs_liveQ/ohtest', 'put', '/', { key: 'Q5', n: 'Una', q: 'Femte', v: 1 });
  await waitFor(() => (mimoEvents.filter((e) => e.type === 'recall' && e.id === 'SET-ON').length === 2), 'set on again');
  mimoEvents.length = 0;
  sse('qs_liveQ/ohtest', 'put', '/', null);
  await sleep(1400);
  assert.equal(mimoEvents.filter((e) => e.type === 'recall' && e.id === 'SET-OFF').length, 1, 'Back was cancelled, only Done recalled');
  // GO by number from Companion: auto-continue starts the next cue together, then auto-follow + wait + signal
  mimoEvents.length = 0;
  await api('POST', '/api/cues/4/go');
  await waitFor(() => ev('signal', 'L-Y') >= 0, 'chain to signal');
  assert.ok(Math.abs(evAt('live', 'L-X').t - evAt('live', 'L-Y').t) < 150, 'auto-continue: together');
  assert.ok(evAt('signal', 'L-Y').t - evAt('live', 'L-Y').t >= 250, 'wait cue between');
  assert.equal(evAt('signal', 'L-Y').value, 'tvGroup_Control__Go_TypeSignal');
  // text cue with {field} from the live question
  sse('qs_liveQ/ohtest', 'put', '/', { key: 'Q9', n: 'Mari', q: 'Niende', v: 1 });
  await sleep(300);
  mimoEvents.length = 0;
  await api('POST', '/api/cues/h/go');
  await waitFor(() => ev('update', 'L-Y', 'Hi Mari') >= 0, 'text cue');
  // restart: GO twice → one recall; stop → none
  sse('qs_liveQ/ohtest', 'put', '/', null);
  await sleep(300);
  mimoEvents.length = 0;
  await api('POST', '/api/cues/2/go');
  await sleep(300);
  await api('POST', '/api/cues/2/go');
  await sleep(1300);
  assert.equal(mimoEvents.filter((e) => e.type === 'recall').length, 1, 'fired twice = restarted, ran once');
  mimoEvents.length = 0;
  await api('POST', '/api/cues/2/go');
  await sleep(200);
  assert.equal((await api('POST', '/api/cues/2/stop')).json[1].running, false);
  await api('POST', '/api/cues/2/go');
  await sleep(200);
  await api('POST', '/api/cues/stop-all');
  await sleep(1200);
  assert.equal(mimoEvents.filter((e) => e.type === 'recall').length, 0, 'stopped cues do nothing');
  assert.equal((await api('POST', '/api/cues/99/go')).status, 400);
  // Auto layers off (Companion toggle): Mukana does not fire cues, GO still works
  assert.equal((await api('POST', '/api/auto-layers', { enabled: false })).json.autoLayers, false);
  mimoEvents.length = 0;
  sse('qs_liveQ/ohtest', 'put', '/', { key: 'Q10', n: 'Ivar', q: 'Tiende', v: 1 });
  await sleep(400);
  assert.equal(ev('recall', 'SET-ON'), -1, 'no Mukana cues with Auto layers off');
  await api('POST', '/api/cues/1/go');
  await waitFor(() => ev('recall', 'SET-ON') >= 0, 'GO works with Auto layers off');
  await api('POST', '/api/cues/stop-all');
  assert.equal((await api('POST', '/api/auto-layers')).json.autoLayers, true, 'toggle');
  sse('qs_liveQ/ohtest', 'put', '/', null);
  await sleep(300);

  // ---- wait can pause until GO / Continue / a Mukana event (optionally with a timeout)
  await cueCfg([
    mk('w1', 'Hold', { type: 'go' }, { type: 'wait', until: 'go', seconds: 0 }, { continue: 'auto-follow' }),
    mk('w2', 'After hold', { type: 'none' }, { type: 'layerLive', layerIds: ['L-Z'] }),
    mk('w3', 'Hold for hands', 'questionLive', { type: 'wait', until: 'answeringStart', seconds: 0 }, { continue: 'auto-follow' }),
    mk('w4', 'After hands', { type: 'none' }, { type: 'layerLive', layerIds: ['L-W'] }),
    mk('w5', 'Hold max', { type: 'go' }, { type: 'wait', until: 'go', seconds: 0.4 }, { continue: 'auto-follow' }),
    mk('w6', 'After timeout', { type: 'none' }, { type: 'layerLive', layerIds: ['L-V'] }),
  ]);
  mimoEvents.length = 0;
  await api('POST', '/api/cues/w1/go');
  await sleep(300);
  const held = (await api('GET', '/api/cues')).json.cues[0];
  assert.equal(held.phase, 'paused');
  assert.equal(held.until, 'go');
  assert.equal(ev('live', 'L-Z'), -1, 'paused: next cue not started');
  await api('POST', '/api/cues/w1/go'); // GO on a paused cue continues it
  await waitFor(() => ev('live', 'L-Z') >= 0, 'GO continues');
  assert.equal((await api('POST', '/api/cues/w1/continue')).status, 400, 'not paused any more');
  mimoEvents.length = 0;
  await api('POST', '/api/cues/1/go');
  await sleep(200);
  await api('POST', '/api/cues/1/continue'); // Companion
  await waitFor(() => ev('live', 'L-Z') >= 0, 'Companion continue');
  mimoEvents.length = 0;
  await api('POST', '/api/cues/w1/go');
  await sleep(200);
  await api('POST', '/api/cues/w1/stop');
  await sleep(300);
  assert.equal(ev('live', 'L-Z'), -1, 'stopped while paused: nothing follows');
  // timeout
  mimoEvents.length = 0;
  const t0 = Date.now();
  await api('POST', '/api/cues/w5/go');
  await waitFor(() => ev('live', 'L-V') >= 0, 'timeout continues');
  assert.ok(Date.now() - t0 >= 350, 'after the timeout');
  // a Mukana event releases it
  mimoEvents.length = 0;
  sse('panel_hands/ohtest', 'put', '/Q11', { array: [{ uid: 'u1', st: 'q', name: 'Ola' }] });
  sse('qs_liveQ/ohtest', 'put', '/', { key: 'Q11', n: 'Elf', q: 'Ellevte', v: 1 });
  await sleep(400);
  assert.equal((await api('GET', '/api/cues')).json.cues[2].phase, 'paused', 'held until a panelist answers');
  assert.equal(ev('live', 'L-W'), -1);
  sse('panel_hands/ohtest', 'put', '/Q11', { array: [{ uid: 'u1', st: 'a', name: 'Ola' }] });
  await waitFor(() => ev('live', 'L-W') >= 0, 'Mukana event continues');
  sse('panel_hands/ohtest', 'put', '/Q11', null);
  sse('qs_liveQ/ohtest', 'put', '/', null);
  await sleep(300);

  // ---- simulation drives everything like Mukana would (and Mukana is ignored meanwhile)
  await cueCfg([mk('s1', 'Q on', 'questionLive', { type: 'layerLive', layerId: 'L-LT' }), mk('s2', 'Hands', 'answeringStart', { type: 'layerLive', layerId: 'L-PAN2' }), mk('s3', 'Notes', 'hostNotes', { type: 'layerLive', layerId: 'L-NOTE' })]);
  assert.equal((await api('POST', '/api/simulate/doneReading')).status, 400, 'needs a live question first');
  await api('POST', '/api/simulate/end');
  mimoEvents.length = 0;
  const sim1 = await api('POST', '/api/simulate/questionLive');
  assert.equal(sim1.json.simulating, true);
  assert.equal(sim1.json.current.values.name, 'Kari Nordmann');
  await waitFor(() => ev('live', 'L-LT') >= 0 && ev('update', 'L-LT', 'Kari Nordmann') >= 0, 'simulated question on air');
  sse('qs_liveQ/ohtest', 'put', '/', { key: 'REAL', n: 'Real Person', q: 'Real', v: 1 });
  await sleep(300);
  assert.equal((await api('GET', '/api/status')).json.current.values.name, 'Kari Nordmann', 'Mukana ignored while simulating');
  await api('POST', '/api/simulate/handRaised');
  await api('POST', '/api/simulate/aboveLine');
  await api('POST', '/api/simulate/answeringStart');
  await waitFor(() => ev('live', 'L-PAN2') >= 0, 'answering cue');
  await api('POST', '/api/simulate/hostNotes');
  await waitFor(() => ev('live', 'L-NOTE') >= 0, 'host notes cue');
  const simLog = (await api('GET', '/api/status')).json.log.map((l) => l.msg).join('\n');
  assert.match(simLog, /simulated\): Panelist raises hand/);
  assert.match(simLog, /simulated\): Panelist moved above the line/);
  const back = await api('POST', '/api/simulate/end');
  assert.equal(back.json.simulating, false);
  assert.equal(back.json.current.values.name, 'Real Person', 'back to Mukana');
  sse('qs_liveQ/ohtest', 'put', '/', null);
  await sleep(300);
  await cueCfg([]);

  // ---------- panelists, run by cues ----------
  const SLOT = (x) => `tvIn_VideoSource${x}Image`;
  const PANEL_CUES = [
    mk('p1', 'Panelist layout', 'answeringChange', { type: 'panelistLayout' }, { continue: 'auto-follow' }),
    mk('p2', 'Panelist name', { type: 'none' }, { type: 'panelistLowerThird' }, { preWait: 0.3 }),
    mk('p3', 'Panelists done', 'answeringEnd', { type: 'layerOff', layerIds: ['L-LT3'] }, { cancels: ['p1', 'p2'] }),
    mk('pr', 'Reader into B', { type: 'go' }, { type: 'roleToSlot', role: 'reader', layerId: 'L-2UP', slot: 'B' }),
    mk('ps', 'QR into C', { type: 'go' }, { type: 'sourceToSlot', sourceId: 'S-QR', layerId: 'L-3UP', slot: 'C' }),
    mk('pp', 'Panel', { type: 'go' }, { type: 'panelLayout' }),
  ];
  const slotSet = (layer, slot, src) => mimoEvents.findIndex((e) => e.type === 'update' && e.id === layer && e.key === SLOT(slot) && e.value === src);
  await api('POST', '/api/config', {
    layerControl: { enabled: true, cues: PANEL_CUES },
    panelists: {
      cast: [
        { uid: 'u1', name: 'Ola', sourceId: 'S-OLA', ltVariantId: 'V-OLA' },
        { uid: 'u2', name: 'Per', sourceId: 'S-PER', ltVariantId: 'V-PER' },
        { uid: 'u3', name: 'Anne', sourceId: 'S-ANNE', ltVariantId: 'V-ANNE' },
        { uid: 'h1', name: 'Host', role: 'host', sourceId: 'S-HOST', ltVariantId: 'V-OLA' },
        { uid: 'r1', name: 'Reader', role: 'reader', sourceId: 'S-READ', ltVariantId: 'V-OLA' },
      ],
      layouts: [
        { count: 1, setId: 'SET-2UP', layerId: 'L-2UP', slots: ['B'] },
        { count: 2, setId: 'SET-3UP', layerId: 'L-3UP', slots: ['B', 'C'] },
      ],
      ltLayerId: 'L-LT3',
      ltMode: 'variant',
      ltDelaySec: 0.3,
      ltOffAfterSec: 0,
    },
  });
  const vars = await api('GET', '/api/mimolive/variants?layer=L-LT3');
  assert.deepEqual(vars.json.map((v) => v.id), ['V-OLA', 'V-PER', 'V-ANNE']);
  sse('panel_onlinelist/ohtest', 'put', '/', { u1: { displayName: 'Ola' }, u2: { displayName: 'Per' } });
  await waitFor(async () => (await api('GET', '/api/status')).json.online.length === 2, 'online list in status');
  // pre-flight roster: captured from hands while the question is on deck, kept after it is answered
  sse('comments_host_output/ohtest', 'put', '/PF', { comment: '***Pre-flight checklist item: Panelists, please raise your hands*', orderID: 9 });
  sse('panel_hands/ohtest', 'put', '/PF', { array: [{ uid: 'u1', name: 'Ola', st: 'q' }, { uid: 'u3', name: 'Anne', st: 'q' }] });
  await waitFor(async () => (await api('GET', '/api/status')).json.roster.length === 2, 'roster captured');
  sse('comments_host_output/ohtest', 'put', '/PF', null);
  sse('comments_answered/ohtest', 'put', '/PF', { comment: '***Pre-flight checklist item: Panelists, please raise your hands*' });
  sse('panel_hands/ohtest', 'put', '/PF', null); // Mukana drops the hands when answered
  await sleep(200);
  assert.deepEqual((await api('GET', '/api/status')).json.roster.map((p) => p.name), ['Ola', 'Anne'], 'roster kept after answered');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).panelists.roster.people.length, 2, 'roster saved');
  sse('panel_hands/ohtest', 'put', '/PF', { u2: true }); // other hands format, late joiner
  await waitFor(async () => (await api('GET', '/api/status')).json.roster.length === 3, 'roster merges late joiners');
  assert.equal((await api('POST', '/api/panelists/roster/clear')).json.roster.length, 0);
  sse('panel_hands/ohtest', 'put', '/PF', null);
  // late arrivals: add everyone with a hand on the live question
  assert.equal((await api('POST', '/api/panelists/roster/from-question')).status, 400, 'no live question');
  sse('panel_hands/ohtest', 'put', '/Q7', { array: [{ uid: 'u5', name: 'Kari Sen', st: 'q', loc: 'Alta' }, { uid: 'u1', name: 'Ola', st: 'a' }] });
  sse('qs_liveQ/ohtest', 'put', '/', { key: 'Q7', n: 'X', q: 'Late', v: 1 });
  await waitFor(async () => (await api('GET', '/api/status')).json.current.key === 'Q7', 'Q7 live');
  const fromQ = await api('POST', '/api/panelists/roster/from-question');
  assert.deepEqual(fromQ.json.people.map((p) => p.name), ['Kari Sen', 'Ola']);
  assert.equal(fromQ.json.added.length, 2);
  assert.equal(fromQ.json.people[0].loc, 'Alta', 'location comes along');
  assert.equal((await api('POST', '/api/panelists/roster/from-question')).json.added.length, 0, 'no duplicates');
  assert.deepEqual((await api('GET', '/api/status')).json.roster.map((p) => p.uid), ['u5', 'u1']);
  sse('qs_liveQ/ohtest', 'put', '/', null);
  await api('POST', '/api/panelists/roster/clear');
  const hands = (...p) => sse('panel_hands/ohtest', 'put', '/', { Q6: { array: p.map(([uid, st]) => ({ uid, st, name: uid })) } });
  hands(['u1', 'q']);
  sse('qs_liveQ/ohtest', 'put', '/', { key: 'Q6', n: 'Sol', q: 'Sjette', v: 1 });
  await sleep(200);

  // the "Add panelist cues" button builds a working list from the Panelists settings
  {
    await cueCfg([]);
    const built = await api('POST', '/api/cues/add-panelist-cues');
    const list = built.json.layerControl.cues;
    const by = (n) => list.find((c) => c.name === n);
    assert.ok(['Reader into B', 'Question overlay off', 'Answering · with host', 'Panelist name', 'Panelists done', 'Shot: with host'].every((n) => by(n)), list.map((c) => c.name).join());
    assert.deepEqual([by('Answering · with host').action, by('Answering · with host').continue], [{ type: 'panelistLayout', shot: 'host' }, 'auto-continue']);
    // timeline: name at the delay (Off after = 0 here, so no "name off" cue)
    assert.equal(by('Panelist name').preWait, 0.3);
    assert.ok(!by('Panelist name off'));
    assert.equal(by('Panelists done').cancels.length, 2);
    await cueCfg(PANEL_CUES); // back to the explicit list for the checks below
  }

  // the host answering alone: nothing (the host never counts)
  mimoEvents.length = 0;
  hands(['h1', 'a']);
  await sleep(500);
  assert.ok(!mimoEvents.some((e) => ['recall', 'vlive', 'live'].includes(e.type) || e.key?.startsWith('tvIn_')), 'host ignored');

  // one panelist: source into B, then the layout, then (cue 2 pre-wait) the lower third
  mimoEvents.length = 0;
  hands(['h1', 'a'], ['u1', 'a']);
  await waitFor(() => ev('vlive', 'V-OLA') >= 0, 'Ola lower third');
  assert.ok(slotSet('L-2UP', 'B', 'S-OLA') >= 0 && slotSet('L-2UP', 'B', 'S-OLA') < ev('recall', 'SET-2UP'), 'source before layout');
  assert.ok(evAt('vlive', 'V-OLA').t - evAt('recall', 'SET-2UP').t >= 250, 'lower third after the pre-wait');
  const ps = (await api('GET', '/api/status')).json.panelists;
  assert.deepEqual(ps.placed.map((x) => [x.uid, x.slot]), [['u1', 'B']], 'host not placed');
  assert.equal(ps.lowerThird.name, 'u1');

  // switch to another single panelist: lower third out first, B cuts, new lower third; layout stays
  mimoEvents.length = 0;
  hands(['u1', 'c'], ['u2', 'a']);
  await waitFor(() => ev('vlive', 'V-PER') >= 0, 'Per lower third');
  assert.ok(ev('off', 'L-LT3') >= 0 && evAt('isOff', 'L-LT3').t <= mimoEvents[slotSet('L-2UP', 'B', 'S-PER')].t, 'lower third out before the source changes');
  assert.equal(ev('recall', 'SET-2UP'), -1, 'layout not recalled again');

  // a second panelist joins: bigger layout, both slots, no lower third with several
  mimoEvents.length = 0;
  hands(['u1', 'c'], ['u2', 'a'], ['u3', 'a']);
  await waitFor(() => ev('recall', 'SET-3UP') >= 0, '3 UP');
  assert.ok(slotSet('L-3UP', 'B', 'S-PER') >= 0 && slotSet('L-3UP', 'C', 'S-ANNE') >= 0 && slotSet('L-3UP', 'C', 'S-ANNE') < ev('recall', 'SET-3UP'));
  assert.ok(ev('off', 'L-LT3') >= 0, 'lower third off with several');
  await sleep(500);
  assert.ok(!mimoEvents.some((e) => e.type === 'vlive'), 'no lower third with several');

  // the first one leaves: the other shifts up into B, smaller layout, no new lower third
  mimoEvents.length = 0;
  hands(['u1', 'c'], ['u2', 'c'], ['u3', 'a']);
  await waitFor(() => ev('recall', 'SET-2UP') >= 0, 'back to 2 UP');
  assert.ok(slotSet('L-2UP', 'B', 'S-ANNE') >= 0 && slotSet('L-2UP', 'B', 'S-ANNE') < ev('recall', 'SET-2UP'));
  await sleep(500);
  assert.ok(!mimoEvents.some((e) => e.type === 'vlive'), 'no lower third after shrinking');

  // nobody answering: the layout stays, "Panelists done" takes the lower third off
  mimoEvents.length = 0;
  hands(['u3', 'c']);
  await waitFor(() => ev('off', 'L-LT3') >= 0, 'done cue');
  await sleep(300);
  assert.ok(!mimoEvents.some((e) => e.type === 'recall' || e.key?.startsWith('tvIn_')), 'layout stays when everyone is done');
  assert.deepEqual((await api('GET', '/api/status')).json.panelists.placed, []);

  // the reader answering counts as a panelist
  mimoEvents.length = 0;
  hands(['r1', 'a']);
  await waitFor(() => slotSet('L-2UP', 'B', 'S-READ') >= 0 && ev('recall', 'SET-2UP') >= 0 && ev('vlive', 'V-OLA') >= 0, 'reader as panelist');
  hands(['r1', 'c']);
  await sleep(400);

  // Role into slot and Source into slot
  mimoEvents.length = 0;
  await api('POST', '/api/cues/pr/go');
  await api('POST', '/api/cues/ps/go');
  await waitFor(() => slotSet('L-2UP', 'B', 'S-READ') >= 0 && slotSet('L-3UP', 'C', 'S-QR') >= 0, 'role and source into slot');

  // Panel layout: everyone approved above the line, host excluded, done ones not, in queue order
  mimoEvents.length = 0;
  hands(['h1', 'q'], ['u1', 'q'], ['u9', 'c'], ['u2', 'q']);
  await sleep(200);
  await api('POST', '/api/cues/pp/go');
  await waitFor(() => ev('recall', 'SET-3UP') >= 0, 'panel layout');
  assert.ok(slotSet('L-3UP', 'B', 'S-OLA') >= 0 && slotSet('L-3UP', 'C', 'S-PER') >= 0 && slotSet('L-3UP', 'C', 'S-PER') < ev('recall', 'SET-3UP'), 'panel in queue order, sources first');
  assert.ok(!mimoEvents.some((e) => e.value === 'S-HOST'), 'host not in the panel');
  const pan = (await api('GET', '/api/status')).json.panelists;
  assert.equal(pan.mode, 'panel');
  assert.deepEqual(pan.panel.map((x) => x.uid), ['u1', 'u2']);
  // the host clicks Per: the answering layout takes over, with his lower third (new shot, though 2 → 1)
  mimoEvents.length = 0;
  hands(['h1', 'q'], ['u1', 'q'], ['u2', 'a']);
  await waitFor(() => ev('vlive', 'V-PER') >= 0, 'answering after the panel');
  assert.ok(slotSet('L-2UP', 'B', 'S-PER') >= 0 && ev('recall', 'SET-2UP') >= 0);
  assert.equal((await api('GET', '/api/status')).json.panelists.mode, 'answering');
  hands(['u2', 'c']);
  await sleep(400);

  // ---- shots: with host → (timeline) name → answering only → name off; Change shot; Companion
  {
    const cfgNow = (await api('GET', '/api/config')).json.panelists;
    await api('POST', '/api/config', {
      panelists: {
        layouts: [
          ...cfgNow.layouts,
          { count: 1, shot: 'solo', setId: 'SET-FULL', layerId: 'L-FULL', slots: ['A'] },
          { count: 0, shot: 'hostOnly', setId: 'SET-HOST', layerId: '', slots: [] },
        ],
      },
    });
    await cueCfg([
      mk('a1', 'Answering · with host', 'answeringChange', { type: 'panelistLayout', shot: 'host' }, { continue: 'auto-continue' }),
      mk('a2', 'Panelist name', { type: 'none' }, { type: 'panelistLowerThird' }, { preWait: 0.2, continue: 'auto-continue' }),
      mk('a3', 'Go single', { type: 'none' }, { type: 'changeShot', shot: 'solo' }, { preWait: 0.6, continue: 'auto-continue' }),
      mk('a4', 'Name off', { type: 'none' }, { type: 'layerOff', layerIds: ['L-LT3'] }, { preWait: 1.2 }),
      mk('a5', 'Done', 'answeringEnd', { type: 'layerOff', layerIds: ['L-LT3'] }, { cancels: ['a1', 'a2', 'a3', 'a4'] }),
      mk('b1', 'Shot: with host', { type: 'go' }, { type: 'changeShot', shot: 'host' }),
      mk('b2', 'Shot: host only', { type: 'go' }, { type: 'changeShot', shot: 'hostOnly' }),
      mk('b3', 'Follow current', { type: 'go' }, { type: 'panelistLayout', shot: 'current' }),
    ]);
    mimoEvents.length = 0;
    hands(['u1', 'a']);
    await waitFor(() => ev('recall', 'SET-FULL') >= 0, 'goes single');
    const t0 = evAt('recall', 'SET-2UP').t;
    assert.ok(slotSet('L-2UP', 'B', 'S-OLA') >= 0, 'with host first');
    assert.ok(evAt('vlive', 'V-OLA').t - t0 >= 150 && evAt('vlive', 'V-OLA').t - t0 < 550, 'name at ~0.2 s');
    assert.ok(evAt('recall', 'SET-FULL').t - t0 >= 550 && evAt('recall', 'SET-FULL').t - t0 < 1100, 'single at ~0.6 s (timeline, not 0.2 + 0.6)');
    assert.ok(slotSet('L-FULL', 'A', 'S-OLA') >= 0 && slotSet('L-FULL', 'A', 'S-OLA') < ev('recall', 'SET-FULL'), 'answering only: source into A first');
    assert.equal(ev('off', 'L-LT3'), -1, 'lower third stays on through the shot change');
    await waitFor(() => ev('off', 'L-LT3') >= 0, 'name off at ~1.2 s');
    assert.equal((await api('GET', '/api/cues')).json.shot, 'solo');
    // host only (Stream Deck), then "current shot" comes back to answering only
    mimoEvents.length = 0;
    await api('POST', '/api/cues/b2/go');
    await waitFor(() => ev('recall', 'SET-HOST') >= 0, 'host only');
    const st1 = (await api('GET', '/api/cues')).json;
    assert.equal(st1.shot, 'hostOnly');
    assert.equal(st1.answerShot, 'solo', 'host only is momentary');
    await api('POST', '/api/cues/b3/go');
    await waitFor(() => ev('recall', 'SET-FULL') >= 0, 'current shot = answering only again');
    // Companion: shot endpoint
    mimoEvents.length = 0;
    const comp = await api('POST', '/api/shot/host');
    assert.equal(comp.json.shot, 'host');
    assert.ok(slotSet('L-2UP', 'B', 'S-OLA') >= 0 && ev('recall', 'SET-2UP') >= 0, 'Companion: with host');
    assert.equal((await api('POST', '/api/shot/sideways')).status, 404);
    // the next panelist restarts the timeline: with host again, then single
    mimoEvents.length = 0;
    hands(['u1', 'c'], ['u2', 'a']);
    await waitFor(() => ev('recall', 'SET-FULL') >= 0, 'next panelist: timeline again');
    assert.ok(slotSet('L-2UP', 'B', 'S-PER') >= 0 && slotSet('L-2UP', 'B', 'S-PER') < ev('recall', 'SET-FULL'), 'with host before single');
    assert.ok(ev('vlive', 'V-PER') >= 0);
    hands(['u2', 'c']);
    await sleep(400);
    await api('POST', '/api/config', { panelists: { layouts: cfgNow.layouts } });
    await cueCfg(PANEL_CUES);
  }

  // a question going live with a panelist already answering fires no answering events
  mimoEvents.length = 0;
  sse('panel_hands/ohtest', 'put', '/Q8', { array: [{ uid: 'u1', st: 'a', name: 'u1' }] });
  sse('qs_liveQ/ohtest', 'put', '/', { key: 'Q8', n: 'Zara', q: 'Åttende', v: 1 });
  await sleep(600);
  assert.ok(!mimoEvents.some((e) => ['recall', 'vlive'].includes(e.type)), 'nothing from panelist cues when a question starts');
  // ...but when they are made answering again, the layout and lower third come
  sse('panel_hands/ohtest', 'put', '/Q8', { array: [{ uid: 'u1', st: 'c', name: 'u1' }] });
  await sleep(300);
  mimoEvents.length = 0;
  sse('panel_hands/ohtest', 'put', '/Q8', { array: [{ uid: 'u1', st: 'a', name: 'u1' }] });
  await waitFor(() => ev('vlive', 'V-OLA') >= 0, 'lower third when activated while live');
  sse('panel_hands/ohtest', 'put', '/Q8', null);
  sse('qs_liveQ/ohtest', 'put', '/', { key: 'Q6', n: 'Sol', q: 'Sjette', v: 1 });
  await sleep(400);

  // text mode: name and title are written into the lower third (while it is off), then it goes live
  await api('POST', '/api/config', {
    panelists: {
      ltMode: 'text',
      cast: [
        { uid: 'u1', name: 'Ola', screenName: 'Ola Nordmann', title: 'Daglig leder, NODA', sourceId: 'S-OLA' },
        { uid: 'u2', name: 'Per', sourceId: 'S-PER' },
      ],
    },
  });
  mimoEvents.length = 0;
  hands(['u1', 'a']);
  await waitFor(() => ev('live', 'L-LT3') >= 0, 'text lower third live');
  const ltName = mimoEvents.findIndex((e) => e.id === 'L-LT3' && e.key === 'tvGroup_Content__Title' && e.value === 'Ola Nordmann');
  const ltTitle = mimoEvents.findIndex((e) => e.id === 'L-LT3' && e.key === 'tvGroup_Content__Subtitle' && e.value === 'Daglig leder, NODA');
  assert.ok(ltName >= 0 && ltTitle >= 0 && ltTitle < ev('live', 'L-LT3'), 'name and title before live');
  assert.ok(!mimoEvents.some((e) => e.type === 'vlive'), 'no variant in text mode');
  mimoEvents.length = 0;
  hands(['u1', 'c'], ['u2', 'a']);
  await waitFor(() => ev('live', 'L-LT3') >= 0, 'second text lower third');
  assert.ok(mimoEvents.some((e) => e.key === 'tvGroup_Content__Title' && e.value === 'u2'), 'Mukana name (here: u2) when no name on screen');
  assert.ok(mimoEvents.some((e) => e.key === 'tvGroup_Content__Subtitle' && e.value === ''), 'empty title is cleared');
  assert.ok(evAt('isOff', 'L-LT3').t <= mimoEvents.find((e) => e.key === 'tvGroup_Content__Title' && e.value === 'u2').t, 'text changes only after the old lower third is off');
  hands(['u2', 'c']);
  await sleep(300);

  // Auto layers off: no live/off at all
  await api('POST', '/api/config', { layerControl: { enabled: false } });
  mimoEvents.length = 0;
  sse('qs_liveQ/ohtest', 'put', '/', { key: 'Q5', n: 'Una', q: 'Femte', v: 1 });
  hands(['u1', 'a']);
  await waitFor(() => ev('update', 'L-LT', 'Una') >= 0, 'text without layer control');
  await sleep(500);
  assert.ok(!mimoEvents.some((e) => ['live', 'off', 'recall', 'vlive'].includes(e.type)), 'no layer actions when off');

  // ---------- show profiles ----------
  {
    assert.equal((await api('GET', '/api/profiles')).json.current, '');
    await api('POST', '/api/config', { layerControl: { enabled: true, cues: [mk('k1', 'Show A cue', 'questionLive', { type: 'layerLive', layerIds: ['L-LT'] })] } });
    const saved = await api('POST', '/api/profiles/save', { name: 'Show A – Tromsø' });
    assert.equal(saved.json.current, 'Show A – Tromsø');
    assert.equal(saved.json.modified, false);
    const pfile = path.join(dataDir, 'profiles', 'show-a-tromso.json');
    assert.ok(fs.existsSync(pfile));
    assert.equal(fs.statSync(pfile).mode & 0o777, 0o600, 'profile file readable by this user only');
    assert.equal(JSON.parse(fs.readFileSync(pfile, 'utf8')).show.mukana.refreshToken, 'RT-good', 'login token saved in the profile');
    assert.equal(saved.json.profiles[0].hasToken, true);
    await api('POST', '/api/config', { targets: [] });
    assert.equal((await api('GET', '/api/profiles')).json.modified, true, 'change → unsaved changes');
    // download: the show only, never the login token or mimoLive password
    await api('POST', '/api/config', { mimolive: { password: 'pw-secret' } });
    const dl = await fetch(`http://127.0.0.1:${appPortMoved || appPort}/api/profiles/export?name=${encodeURIComponent('Show A – Tromsø')}`);
    assert.match(dl.headers.get('content-disposition'), /attachment; filename="show-a-tromso.json"/);
    const file = await dl.text();
    assert.ok(!/RT-good|pw-secret|refreshToken|password/.test(file), 'no secrets in a download by default');
    const withTok = await (await fetch(`http://127.0.0.1:${appPortMoved || appPort}/api/profiles/export?name=${encodeURIComponent('Show A – Tromsø')}&token=1`)).text();
    assert.match(withTok, /RT-good/, 'token in the download when asked for');
    assert.ok(!/pw-secret/.test(withTok), 'never the mimoLive password');
    const doc = JSON.parse(file);
    assert.equal(doc.show.mukana.eventId, 'ohtest');
    assert.ok(doc.show.targets.length > 0);
    // new show: empty, Auto layers off, Mukana disconnected (no event)
    const reset = await api('POST', '/api/profiles/reset');
    assert.equal(reset.json.current, '');
    const blank = (await api('GET', '/api/config')).json;
    assert.deepEqual([blank.mukana.eventId, blank.mimolive.documentId, blank.targets.length, blank.layerControl.cues.length, blank.layerControl.enabled, blank.panelists.cast.length], ['', '', 0, 0, false, 0]);
    assert.equal(blank.mukana.hasRefreshToken, true, 'login kept on New show');
    assert.equal(blank.mimolive.hasPassword, true, 'mimoLive password kept');
    assert.equal(blank.mimolive.port, mimoPort, 'mimoLive machine kept');
    assert.equal((await api('GET', '/api/status')).json.running, false);
    // load: everything back, Auto layers off, Mukana reconnected
    const loaded = await api('POST', '/api/profiles/load', { name: 'Show A – Tromsø' });
    assert.equal(loaded.json.current, 'Show A – Tromsø');
    assert.equal(loaded.json.modified, false);
    const back = (await api('GET', '/api/config')).json;
    assert.equal(back.mukana.eventId, 'ohtest');
    assert.equal(back.layerControl.cues[0].name, 'Show A cue');
    assert.equal(back.layerControl.enabled, false, 'Auto layers off after load');
    assert.equal(back.layerControl.panelistCuesAdded, true, 'no automatic cue conversion on restart');
    assert.ok(back.targets.length > 0);
    await waitFor(async () => (await api('GET', '/api/status')).json.running, 'Mukana reconnected');
    // upload under another name, delete, unknown names
    const up = await api('POST', '/api/profiles/import', { profile: { ...doc, name: 'Show B' } });
    assert.equal(up.json.imported, 'Show B');
    assert.equal(up.json.profiles.find((p) => p.name === 'Show B').hasToken, false, 'downloaded without token');
    assert.deepEqual(up.json.profiles.map((p) => p.name), ['Show A – Tromsø', 'Show B']);
    assert.equal((await api('POST', '/api/profiles/import', { profile: { hello: 1 } })).status, 400);
    assert.equal((await api('POST', '/api/profiles/delete', { name: 'Show B' })).json.profiles.length, 1);
    assert.equal((await api('POST', '/api/profiles/load', { name: 'Nope' })).status, 400);
    assert.equal((await api('POST', '/api/profiles/save', { name: ' ' })).status, 400);
    await api('POST', '/api/config', { mimolive: { clearPassword: true } });
  }

  // change listen port at runtime
  const srv = await api('GET', '/api/server');
  assert.equal(srv.json.port, appPort);
  assert.ok(srv.json.addresses.some((x) => x.address === '0.0.0.0'));
  assert.equal((await api('POST', '/api/server', { host: '127.0.0.1', port: 70000 })).status, 400);
  const newPort = appPort + 1;
  const moved = await api('POST', '/api/server', { host: '127.0.0.1', port: newPort });
  assert.equal(moved.json.changed, true, JSON.stringify(moved.json));
  assert.equal((await fetch(`http://127.0.0.1:${newPort}/api/status`)).status, 200);
  await sleep(1700);
  assert.ok(await fetch(`http://127.0.0.1:${appPort}/api/status`).then(() => false, () => true), 'old port closed');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).server.port, newPort);
  appPortMoved = newPort;

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
