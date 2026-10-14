// Sync engine: Mukana RTDB streams -> derived fields -> mimoLive targets.
import { EventEmitter } from 'node:events';
import { TokenManager, RtdbStream } from './firebase.js';
import { MimoLive } from './mimolive.js';
import { FIELDS } from './config.js';

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
    panelistsOnline: String(Object.keys(online && typeof online === 'object' ? online : {}).length),
  };
}

/** Pure: compute output fields from the RTDB trees. */
export function deriveFields(liveQ, hands, onlineList, hostOutput, sourceList, answered) {
  const lists = { hostOutput, online: onlineList, source: sourceList, answered };
  const empty = Object.fromEntries(FIELDS.map((f) => [f.id, '']));
  if (!liveQ || typeof liveQ !== 'object' || !liveQ.key) {
    return { active: false, key: null, values: { ...empty, ...rundown(lists, null) } };
  }

  // Full record from the panel list has more fields than the compact liveQ node
  const rec = (hostOutput && hostOutput[liveQ.key]) || {};
  const full = cleanText(liveQ.q || rec.comment || rec.question);
  const { url, rest } = extractUrl(full);
  const cc = liveQ.loc_cc || rec.loc_cc || '';
  const source = rec.source || 'mukana';
  const arr = hands?.[liveQ.key]?.array;
  const list = Array.isArray(arr) ? arr : arr && typeof arr === 'object' ? Object.values(arr) : [];
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
    this.sending = false;
    this.pending = false;
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
    this.addLog('info', 'Stopped');
  }

  recompute() {
    const prevKey = this.current.key;
    this.current = deriveFields(this.trees.liveQ, this.trees.hands, this.trees.online, this.trees.hostOutput, this.trees.source, this.trees.answered);
    if (prevKey !== this.current.key) {
      this.addLog('info', this.current.active ? `Live question: ${this.current.values.name} – "${this.current.values.question.slice(0, 60)}"` : 'No live question – clearing');
    }
    this.push();
  }

  /** Push changed values to mimoLive. Coalesces bursts. */
  async push(force = false) {
    if (force) this.lastSent.clear();
    if (this.sending) {
      this.pending = true;
      return;
    }
    this.sending = true;
    try {
      do {
        this.pending = false;
        const cfg = this.getConfig();
        const ml = new MimoLive(cfg.mimolive);
        const docId = cfg.mimolive.documentId;
        if (!docId) break;
        const jobs = [];
        for (const t of cfg.targets) {
          if (!t.id || !t.key || !t.field) continue;
          const value = this.current.values[t.field] ?? '';
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
      } while (this.pending);
    } finally {
      this.sending = false;
    }
  }

  async clear() {
    const saved = this.current;
    this.current = deriveFields(null);
    await this.push(true);
    this.current = saved;
  }

  status() {
    return {
      running: this.running,
      user: this.user,
      mukanaError: this.mukanaError,
      streams: Object.fromEntries(Object.entries(this.streams).map(([k, s]) => [k, s.status])),
      current: this.current,
      stats: this.stats,
      log: this.log.slice(-60),
    };
  }
}
