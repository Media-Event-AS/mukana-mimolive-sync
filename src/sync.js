// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Ronny Hofsøy, Media Event AS
// Sync engine: Mukana RTDB streams -> derived fields -> mimoLive targets.
import { EventEmitter } from 'node:events';
import { TokenManager, RtdbStream } from './firebase.js';
import { MimoLive, MimoLiveAuthError } from './mimolive.js';
import { FIELDS } from './config.js';
import { CueEngine, detectEvents, EVENTS } from './cues.js';
import { PanelistController } from './panelists.js';

const URL_RE = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+\.[^\s<>"']+)/i;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
export function cleanText(s) {
  return String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => {
      if (ENTITIES[e.toLowerCase()]) return ENTITIES[e.toLowerCase()];
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return m;
    })
    .trim();
}

export function extractUrl(text) {
  const m = text.match(URL_RE);
  if (!m) return { url: '', rest: text };
  const url = m[0].replace(/[.,;:!?)\]]+$/, '');
  const rest = text
    .replace(url, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/(^|\s)[,;:]+(?=\s|$)/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[\s,;:]+$/, '')
    .trim();
  return { url, rest };
}

const SOURCE_LABELS = {
  mukana: 'Mobile', lite: 'Mobile', full: 'Web', form: 'QR form', panel: 'Panel',
  chat: 'Chat', blockedWord: 'Filtered', facebook: 'Facebook', youtube: 'YouTube', twitter: 'Twitter',
};

export function flagEmoji(cc) {
  const s = String(cc || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(s)) return '';
  return String.fromCodePoint(...[...s].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function hhmm(ts) {
  const n = Number(ts);
  if (!n) return '';
  return new Date(n).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

const isVisible = (q) => q && typeof q === 'object' && !q.ts_removed;
const obj = (x) => (x && typeof x === 'object' ? x : {});

/** Panelists online now (hosts excluded). `online` is authoritative; ts_off can be stale. */
export function onlinePanelists(online) {
  return Object.entries(obj(online))
    .filter(([, p]) => p && p.online !== false && !p.host)
    .map(([uid, p]) => ({ uid, name: cleanText(p.displayName) || uid, loc: cleanText(p.loc) }));
}

/**
 * A question's hands node: { <uid>: true } for hands raised "below the line", and
 * { array: [{ uid, name, st }] } for the queue "above the line" (st: q queued, a answering, c done).
 */
export function handsOf(node) {
  const n = obj(node);
  const list = (Array.isArray(n.array) ? n.array : Object.values(obj(n.array))).filter((p) => p?.uid);
  return {
    raised: Object.keys(n).filter((k) => n[k] === true),
    list,
    queued: list.filter((p) => p.st === 'q').map((p) => String(p.uid)),
  };
}

/** Everyone in a hands node, raised or in the queue. */
export function handsPeople(node, online) {
  const nameOf = (uid, n) => cleanText(n) || cleanText(obj(online)[uid]?.displayName) || uid;
  const locOf = (uid, l) => cleanText(l) || cleanText(obj(online)[uid]?.loc);
  const { raised, list } = handsOf(node);
  const people = list.map((p) => ({ uid: String(p.uid), name: nameOf(p.uid, p.name), loc: locOf(p.uid, p.loc) }));
  for (const uid of raised) if (!people.some((p) => p.uid === uid)) people.push({ uid, name: nameOf(uid), loc: locOf(uid) });
  return people;
}

/** Keys of questions whose text contains `match` (live, on deck, answered or voting). */
export function findQuestions(trees, match) {
  const needle = String(match || '').trim().toLowerCase();
  if (!needle) return [];
  const keys = new Set();
  const test = (k, q) => k && cleanText(q?.comment || q?.question || q?.q).toLowerCase().includes(needle) && keys.add(k);
  if (trees.liveQ?.key) test(trees.liveQ.key, trees.liveQ);
  for (const t of [trees.hostOutput, trees.answered, trees.source]) for (const [k, q] of Object.entries(obj(t))) test(k, q);
  return [...keys];
}
const countOf = (tree) => String(Object.values(tree && typeof tree === 'object' ? tree : {}).filter(isVisible).length);

/** Fields that exist with or without a live question: next up + counts. */
function rundown({ hostOutput, online, source, answered }, activeKey) {
  const items = Object.entries(hostOutput && typeof hostOutput === 'object' ? hostOutput : {})
    .filter(([k, q]) => isVisible(q) && k !== activeKey && q.status !== 'answering' && q.status !== 'complete')
    .sort(([, a], [, b]) => (a.orderID ?? 0) - (b.orderID ?? 0) || (a.ts_created ?? 0) - (b.ts_created ?? 0));
  const next = items[0]?.[1];
  const nextFull = next ? cleanText(next.comment || next.question) : '';
  return {
    nextName: next ? cleanText(next.displayName) : '',
    nextLocation: next ? cleanText(next.city || next.location) : '',
    nextTag: next ? cleanText(next.tag) : '',
    nextQuestion: next ? extractUrl(nextFull).rest : '',
    nextQuestionFull: nextFull,
    votingCount: countOf(source), // Mukana "Voting Qs" tab
    onDeckCount: countOf(hostOutput), // Mukana "On Deck" tab (includes the live question)
    answeredCount: countOf(answered), // Mukana "Answered" tab
    panelistsOnline: String(onlinePanelists(online).length),
  };
}

/** Pure: compute output fields from the RTDB trees. */
export function deriveFields(liveQ, hands, onlineList, hostOutput, sourceList, answered) {
  const lists = { hostOutput, online: onlineList, source: sourceList, answered };
  const empty = Object.fromEntries(FIELDS.map((f) => [f.id, '']));
  if (!liveQ || typeof liveQ !== 'object' || !liveQ.key) {
    return { active: false, key: null, answering: [], panel: [], raised: [], queued: [], values: { ...empty, ...rundown(lists, null) } };
  }

  // Full record from the panel list has more fields than the compact liveQ node
  const rec = (hostOutput && hostOutput[liveQ.key]) || {};
  const full = cleanText(liveQ.q || rec.comment || rec.question);
  const { url, rest } = extractUrl(full);
  const cc = liveQ.loc_cc || rec.loc_cc || '';
  const source = rec.source || 'mukana';
  const { raised, list, queued: queuedUids } = handsOf(hands?.[liveQ.key]);
  const nameOf = (p) => p?.name || onlineList?.[p?.uid]?.displayName || p?.uid || '';
  const queued = [];
  let activePanelist = '';
  list.forEach((p, i) => {
    if (!p) return;
    if (p.st === 'q') queued.push(`${i + 1}. ${nameOf(p)}`);
    else if (p.st === 'a' && !activePanelist) activePanelist = nameOf(p);
  });

  return {
    active: true,
    key: liveQ.key,
    read: !!liveQ.rd,
    // Panelists answering now, in Mukana's order. uid identifies them across name changes.
    answering: list.filter((p) => p?.st === 'a').map((p) => ({ uid: String(p.uid || nameOf(p)), name: nameOf(p) })),
    // The panel for this question: approved above the line or answering, in queue order.
    panel: list.filter((p) => p.st === 'q' || p.st === 'a').map((p) => ({ uid: String(p.uid), name: nameOf(p) })),
    raised, // hands below the line
    queued: queuedUids, // moved above the line, waiting
    values: {
      ...empty,
      name: cleanText(liveQ.n || rec.displayName),
      question: rest,
      questionFull: full,
      location: cleanText(liveQ.l || rec.city || rec.location),
      countryCode: String(cc).toUpperCase(),
      countryFlag: flagEmoji(cc),
      tag: cleanText(liveQ.tag || rec.tag),
      votes: String(Math.abs(Number(liveQ.v ?? rec.vote_count) || 0)), // Mukana stores votes negated for sorting
      url,
      notes: cleanText(rec.hostNotes),
      source,
      sourceLabel: SOURCE_LABELS[source] || source,
      namePhonetic: cleanText(rec.namePho),
      locationPhonetic: cleanText(rec.locPho),
      askedAt: hhmm(liveQ.ts || rec.ts_created),
      answeringSince: hhmm(rec.ts_answered),
      doneReading: liveQ.rd ? 'yes' : '',
      queue: queued.join(', '),
      activePanelist,
      ...rundown(lists, liveQ.key),
    },
  };
}

const SAMPLES = [
  { name: 'Kari Nordmann', loc: 'Tromsø, Norway', cc: 'no', q: 'Simulated question: how will the new harbour plan change everyday life in the city centre?' },
  { name: 'Jonas Berg', loc: 'Bodø, Norway', cc: 'no', q: 'Simulated question: what is the most important thing we can do this year? https://example.com/survey' },
  { name: 'Aino Virtanen', loc: 'Oulu, Finland', cc: 'fi', q: 'Simulated question, a bit longer this time, to check that the text fits in the graphic when people write more than one line.' },
];

export class SyncEngine extends EventEmitter {
  constructor(getConfig, onRefreshToken) {
    super();
    this.getConfig = getConfig;
    this.onRefreshToken = onRefreshToken;
    this.running = false;
    this.streams = {};
    this.trees = { liveQ: null, hands: null, online: null, hostOutput: null, source: null, answered: null };
    this.current = deriveFields(null);
    this.lastSent = new Map(); // targetKey -> value
    this.sending = null; // promise of the running push loop
    this.looping = false;
    this.pending = false;
    this.loaded = new Set(); // streams that delivered their first snapshot
    this.clearing = false;
    this.cues = new CueEngine(this);
    this.sim = null; // { trees, n } while simulating: replaces the Mukana input
    this.mimoHealth = { state: 'unset', message: 'No mimoLive set', checkedAt: null };
    this.panelists = new PanelistController(this);
    this.log = [];
    this.stats = { updates: 0, errors: 0, lastUpdate: null };
    this.user = null;
    this.mukanaError = null;
  }

  addLog(level, msg) {
    const entry = { ts: Date.now(), level, msg };
    this.log.push(entry);
    if (this.log.length > 200) this.log.shift();
    if (level === 'error') console.error(`[sync] ${msg}`);
    else console.log(`[sync] ${msg}`);
  }

  async start() {
    if (this.running) return;
    const cfg = this.getConfig();
    if (!cfg.mukana.eventId) throw new Error('Event ID is missing');
    if (!cfg.mukana.refreshToken) throw new Error('Refresh token is missing');
    this.running = true;
    this.mukanaError = null;
    this.lastSent.clear();

    this.tokens = new TokenManager(cfg.mukana);
    this.tokens.on('refreshToken', (t) => this.onRefreshToken?.(t));
    this.tokens.on('token', () => {
      this.user = this.tokens.user;
      Object.values(this.streams).forEach((s) => s.restart());
    });
    this.tokens.on('error', (e) => {
      this.mukanaError = e.message;
      this.addLog('error', e.message);
    });
    try {
      await this.tokens.refresh();
    } catch (e) {
      this.running = false;
      this.mukanaError = e.message;
      throw e;
    }
    this.user = this.tokens.user;
    this.addLog('info', `Signed in as ${this.user.email || this.user.uid}`);

    const ev = cfg.mukana.eventId;
    const getToken = async () => {
      if (Date.now() > this.tokens.expiresAt - 60_000) await this.tokens.refresh();
      return this.tokens.idToken;
    };
    const mk = (name, path) => {
      const s = new RtdbStream({ databaseURL: cfg.mukana.databaseURL, path, getToken });
      s.on('value', (tree) => {
        this.trees[name] = tree;
        this.loaded.add(name);
        this.recompute();
      });
      s.on('status', (st, detail) => {
        if (st === 'error') this.addLog('error', `${path}: ${detail}`);
        this.emit('status');
      });
      s.on('authRevoked', () => this.tokens.refresh().catch((e) => this.addLog('error', e.message)));
      this.streams[name] = s;
      s.start();
    };
    mk('liveQ', `qs_liveQ/${ev}`);
    mk('hands', `panel_hands/${ev}`);
    mk('online', `panel_onlinelist/${ev}`);
    mk('hostOutput', `comments_host_output/${ev}`);
    mk('source', `comments_source/${ev}`);
    mk('answered', `comments_answered/${ev}`);
    this.addLog('info', `Listening to event "${ev}"`);
  }

  stop() {
    this.running = false;
    Object.values(this.streams).forEach((s) => s.stop());
    this.streams = {};
    this.tokens?.stop();
    this.trees = { liveQ: null, hands: null, online: null, hostOutput: null, source: null, answered: null };
    this.loaded.clear();
    this.cues.reset();
    this.panelists.reset();
    this.addLog('info', 'Stopped');
  }

  /**
   * Check mimoLive every few seconds, sync running or not: reachable, password, document open.
   * state: ok | nodoc (reachable, show document not open) | auth | error | unset
   */
  startHealthCheck(everyMs = 5000) {
    let seq = 0;
    const check = async () => {
      const mine = ++seq; // only the newest check counts (an old address may still be timing out)
      const m = this.getConfig().mimolive;
      let h;
      if (!m.host) h = { state: 'unset', message: 'No mimoLive set' };
      else {
        try {
          const docs = await new MimoLive(m).documents();
          const doc = docs.find((d) => d.id === String(m.documentId));
          h = !m.documentId
            ? { state: 'nodoc', message: `Reachable at ${m.host}, no document chosen` }
            : doc
              ? { state: 'ok', message: `${m.host} · ${doc.name}` }
              : { state: 'nodoc', message: `Reachable at ${m.host}, but the show document is not open` };
        } catch (e) {
          h = e instanceof MimoLiveAuthError
            ? { state: 'auth', message: m.password ? 'The saved mimoLive password is wrong: correct it in 2 · mimoLive' : 'mimoLive requires a password: enter it in 2 · mimoLive' }
            : { state: 'error', message: `Not reachable at ${m.host}:${m.port} (${e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.message})` };
        }
      }
      if (mine !== seq) return;
      const changed = h.state !== this.mimoHealth.state;
      this.mimoHealth = { ...h, checkedAt: Date.now() };
      if (changed && this.mimoHealth.state !== 'unset') this.addLog(h.state === 'ok' ? 'info' : 'error', `mimoLive: ${h.message}`);
    };
    this.checkMimoLive = check; // run now, e.g. after the mimoLive settings changed
    check();
    this.healthTimer = setInterval(check, everyMs);
    this.healthTimer.unref?.();
  }

  /** All streams have delivered their first snapshot. */
  ready() {
    return !!this.sim || (this.running && this.loaded.size === Object.keys(this.trees).length);
  }

  derive() {
    const t = this.sim?.trees || this.trees;
    const d = deriveFields(t.liveQ, t.hands, t.online, t.hostOutput, t.source, t.answered);
    d.countable = this.panelists.countable(d.answering); // answering, host excluded (roles)
    return d;
  }

  recompute() {
    this.panelists.captureRoster(this.trees); // real Mukana only
    if (this.sim && !this.sim.recomputing) return; // Mukana is ignored while simulating
    const prev = this.current;
    this.current = this.derive();
    if (prev.key !== this.current.key) {
      this.addLog('info', this.current.active ? `Live question: ${this.current.values.name} – "${this.current.values.question.slice(0, 60)}"` : 'No live question – clearing');
    }
    const events = this.cues.primed ? detectEvents(prev, this.current) : [];
    if (events.length) this.addLog('info', `Mukana${this.sim ? ' (simulated)' : ''}: ${events.map((e) => EVENTS[e]).join(' · ')}`);
    if (!this.cues.primed && this.ready()) this.cues.prime();
    else this.cues.beforePush(prev, events);
    if (!this.panelists.primed && this.ready()) this.panelists.prime();
    this.push();
    if (events.length) this.cues.onEvents(events);
  }

  // ---------- simulation ----------

  /**
   * Simulate a Mukana event. While simulating, the service runs on a sample question instead of
   * Mukana, so cues, question text and panelists all behave as in a show (mimoLive is driven).
   */
  simulate(event, { uid } = {}) {
    if (!EVENTS[event]) throw new Error(`Unknown event ${event}`);
    if (event === 'answeringChange') throw new Error('Simulate “Panelist starts answering” or “Last panelist stops answering”: the change follows from those');
    if (!this.sim) this.startSim();
    const t = this.sim.trees;
    const key = t.liveQ?.key;
    const needQ = !['questionLive', 'questionNext'].includes(event);
    if (needQ && !key && event !== 'questionDone') throw new Error('Simulate “Question goes live” first');
    const person = () => {
      const c = (this.getConfig().panelists?.cast || []).find((x) => x.uid === uid);
      const p = { uid: uid || 'sim-guest', name: c?.screenName || c?.name || 'Sample Panelist' };
      t.online = { ...t.online, [p.uid]: { displayName: p.name, online: true, loc: 'Tromsø, Norway' } };
      return p;
    };
    const node = () => (t.hands[key] ||= { array: [] });
    const entry = (p, st) => {
      const n = node();
      delete n[p.uid];
      n.array = [...(n.array || []).filter((x) => x.uid !== p.uid), { uid: p.uid, name: p.name, st, loc: 'Tromsø, Norway' }];
    };
    switch (event) {
      case 'questionLive':
      case 'questionNext': {
        const n = ++this.sim.n;
        const s = SAMPLES[(n - 1) % SAMPLES.length];
        const k = `SIM-${n}`;
        t.liveQ = { key: k, n: s.name, l: s.loc, q: s.q, tag: 'Simulated', v: -3, loc_cc: s.cc };
        t.hostOutput = { [k]: { displayName: s.name, comment: s.q, city: s.loc, tag: 'Simulated', status: 'answering', orderID: 1, source: 'mukana' } };
        t.hands = { [k]: { array: [] } };
        break;
      }
      case 'questionDone':
        t.liveQ = null;
        t.hostOutput = {};
        break;
      case 'doneReading':
        t.liveQ = { ...t.liveQ, rd: true };
        break;
      case 'handRaised': {
        const p = person();
        node()[p.uid] = true;
        break;
      }
      case 'aboveLine':
        entry(person(), 'q');
        break;
      case 'answeringStart':
        entry(person(), 'a');
        break;
      case 'answeringEnd':
        node().array = (node().array || []).map((x) => (x.st === 'a' ? { ...x, st: 'c' } : x));
        break;
      case 'hostNotes':
        t.hostOutput = { ...t.hostOutput, [key]: { ...t.hostOutput[key], hostNotes: `Simulated host note ${new Date().toLocaleTimeString('en-GB')}` } };
        break;
    }
    this.sim.recomputing = true;
    try {
      this.recompute();
    } finally {
      this.sim.recomputing = false;
    }
    return this.status();
  }

  /** Switch the input to an empty simulated Mukana without firing anything. */
  startSim() {
    this.sim = { n: 0, trees: { liveQ: null, hands: {}, online: { ...(this.trees.online || {}) }, hostOutput: {}, source: {}, answered: {} } };
    this.addLog('info', 'Simulation started: Mukana is ignored until you end it');
    this.current = this.derive();
    this.cues.prime();
    this.panelists.prime();
    this.push();
  }

  endSim() {
    if (!this.sim) return this.status();
    this.sim = null;
    this.addLog('info', 'Simulation ended: back to Mukana');
    this.current = this.derive();
    if (this.ready()) {
      this.cues.prime();
      this.panelists.prime();
    } else {
      this.cues.reset();
      this.panelists.reset();
    }
    this.push();
    return this.status();
  }

  /** Value sent to a mapping target: held by layer control during a transition, else current. */
  valueFor(t) {
    const held = this.clearing ? undefined : this.cues.held(t);
    return held !== undefined ? held : this.current.values[t.field] ?? '';
  }

  /** Push changed values to mimoLive. Coalesces bursts. Resolves when everything queued is sent. */
  push(force = false) {
    if (force) this.lastSent.clear();
    this.pending = true;
    // `looping` is cleared in the same tick the loop ends, so an update can never fall in between.
    if (!this.looping) this.sending = this.pushLoop();
    return this.sending;
  }

  async pushLoop() {
    this.looping = true;
    try {
      while (this.pending) {
        await this.pushOnce();
      }
    } finally {
      this.looping = false;
    }
  }

  /** Send every value that changed since it was last sent. */
  async pushOnce() {
    this.pending = false;
    const cfg = this.getConfig();
    const ml = new MimoLive(cfg.mimolive);
    const docId = cfg.mimolive.documentId;
    if (!docId) return;
    const jobs = [];
    for (const t of cfg.targets) {
      if (!t.id || !t.key || !t.field) continue;
      const value = this.valueFor(t);
      const tk = `${t.kind}:${t.id}:${t.key}`;
      // Several fields may share a target; last one wins, so dedupe by target key per round
      if (this.lastSent.get(tk) === value) continue;
      jobs.push(
        ml
          .setInput({ documentId: docId, kind: t.kind, id: t.id, key: t.key, value })
          .then(() => {
            this.lastSent.set(tk, value);
            this.stats.updates++;
            this.stats.lastUpdate = Date.now();
          })
          .catch((e) => {
            this.stats.errors++;
            this.lastSent.delete(tk);
            this.addLog('error', `mimoLive ${t.field} → ${t.kind} ${t.id.slice(0, 8)}: ${e.message}`);
          })
      );
    }
    if (jobs.length) await Promise.all(jobs);
    this.emit('status');
  }

  async clear() {
    const saved = this.current;
    this.current = deriveFields(null);
    this.clearing = true;
    try {
      await this.push(true);
    } finally {
      this.current = saved;
      this.clearing = false;
    }
  }

  status() {
    return {
      running: this.running,
      user: this.user,
      mukanaError: this.mukanaError,
      streams: Object.fromEntries(Object.entries(this.streams).map(([k, s]) => [k, s.status])),
      current: this.current,
      stats: this.stats,
      autoLayers: !!this.getConfig().layerControl?.enabled,
      mimolive: this.mimoHealth,
      cues: this.cues.status(),
      simulating: !!this.sim,
      panelists: this.panelists.status(),
      // Candidates for the panelists table: hands on the pre-flight question, else online now
      online: onlinePanelists(this.trees.online),
      roster: this.panelists.roster(),
      log: this.log.slice(-60),
    };
  }
}
