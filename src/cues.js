// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Ronny Hofsøy, Media Event AS
// Cue list for mimoLive, QLab style. Each cue has a trigger (a Mukana event, or GO from the UI
// or Companion), a pre-wait, one action, and a continue mode:
//   none           the list stops here
//   auto-continue  the next cue starts at the same moment as this one, so the pre-waits of a
//                  run of auto-continued cues read like a timeline (0 s, 3 s, 6 s…)
//   auto-follow    the next cue starts when this one's action has finished
// A Wait can pause until GO / Continue or a Mukana event releases it (optionally with a timeout).
// A cue that is fired again restarts and stops everything it started. A cue can also stop
// other cues ("cancels") when it fires.
//
// Question text timing is built in: when the live question changes, mapped question text in
// layers a cue has taken live is held at what is on screen. A cue that takes such a layer live
// first takes it off (out-animation), then writes the new text; a cue that takes it off clears
// the text only once it is off. Text not touched by any triggered cue is released when their
// actions are done.
import { MimoLive } from './mimolive.js';
import { FIELDS } from './config.js';
import { slotKey } from './panelists.js';

export const EVENTS = {
  questionLive: 'Question goes live',
  questionNext: 'Next question replaces the live one',
  questionDone: 'Question done or cancelled',
  doneReading: 'Host marks done reading',
  handRaised: 'Panelist raises hand',
  aboveLine: 'Panelist moved above the line',
  answeringStart: 'Panelist starts answering',
  answeringChange: 'Panelists answering change (join, leave, switch)',
  answeringEnd: 'Last panelist stops answering',
  hostNotes: 'Host notes added or changed',
};

export const ACTIONS = {
  recallSet: 'Recall layer set',
  layerLive: 'Layers live',
  layerOff: 'Layers off',
  panelLayout: 'Panel layout (above the line)',
  panelistLayout: 'Answering layout (who answers now)',
  changeShot: 'Change shot',
  panelistLowerThird: 'Panelist lower third',
  sourceToSlot: 'Source into slot',
  roleToSlot: 'Role into slot',
  setLayersOff: "Switch off a set's layers",
  writeText: 'Write text',
  signal: 'Trigger signal',
  wait: 'Wait',
  fireCue: 'Fire cue',
};

export const SHOTS = { host: 'with host', solo: 'answering only', hostOnly: 'host only', current: 'current shot' };

const QUESTION_FIELDS = new Set(FIELDS.filter((f) => f.group === 'Question').map((f) => f.id));
const OFF_STATES = new Set(['off', 'preview']);
const WAIT_OFF_MS = 5000; // longest out-transition we wait for
const SET_FALLBACK_MS = 1500; // wait after a layer set when mimoLive does not list its layers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until every layer has finished its out-transition. Returns false on timeout. */
export async function waitOff(ml, doc, layers, ms = WAIT_OFF_MS) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const states = await Promise.all(layers.map((id) => ml.layerState(doc, id).catch(() => 'off')));
    if (states.every((s) => OFF_STATES.has(s))) return true;
    await sleep(100);
  }
  return false;
}

/**
 * Mukana events between two derived states. Hand and notes events only count within the same
 * question (a question going live with hands up only fires "goes live"); "last panelist stops"
 * also fires when the question ends or changes while panelists were answering.
 * Answering events use `countable` (roles applied: the host never counts) when present.
 */
export function detectEvents(prev, cur) {
  const events = [];
  if (!prev.key && cur.key) events.push('questionLive');
  else if (prev.key && cur.key && prev.key !== cur.key) events.push('questionLive', 'questionNext');
  else if (prev.key && !cur.key) events.push('questionDone');
  const uids = (list) => (list || []).map((p) => (typeof p === 'string' ? p : p.uid));
  const ans = (d) => uids(d.countable ?? d.answering);
  const sameQ = !!cur.key && prev.key === cur.key;
  if (ans(prev).length && !ans(cur).length) events.push('answeringChange', 'answeringEnd');
  if (!sameQ) return events;
  const added = (now, before) => uids(now).some((u) => !uids(before).includes(u));
  if (cur.read && !prev.read) events.push('doneReading');
  if (added(cur.raised, prev.raised)) events.push('handRaised');
  if (added(cur.queued, prev.queued)) events.push('aboveLine');
  if (added(ans(cur), ans(prev))) events.push('answeringStart');
  if (ans(cur).length && ans(cur).join() !== ans(prev).join()) events.push('answeringChange');
  if (cur.values.notes && cur.values.notes !== prev.values.notes) events.push('hostNotes');
  return events;
}

/** Old layer control rules → cues. */
export function migrateRules(rules = []) {
  const cues = [];
  const id = () => Math.random().toString(36).slice(2, 10);
  for (const r of rules) {
    if (r.trigger !== 'question' || !(r.layerId || r.onSetId)) continue;
    const name = r.label || 'Question';
    const set = r.action === 'layerSet';
    const off = set ? (r.offSetId ? { type: 'recallSet', setId: r.offSetId } : { type: 'setLayersOff', setId: r.onSetId }) : { type: 'layerOff', layerId: r.layerId };
    const mine = [];
    const on = { id: id(), name: `${name} on`, trigger: { type: 'mukana', event: 'questionLive' }, preWait: 0, action: set ? { type: 'recallSet', setId: r.onSetId } : { type: 'layerLive', layerId: r.layerId }, continue: 'none', cancels: [] };
    mine.push(on);
    if (Number(r.offAfterSec) > 0) {
      on.continue = 'auto-follow';
      mine.push({ id: id(), name: `${name} auto-off`, trigger: { type: 'none' }, preWait: Number(r.offAfterSec), action: { ...off }, continue: 'none', cancels: [] });
    }
    mine.push({ id: id(), name: `${name} done`, trigger: { type: 'mukana', event: 'questionDone' }, preWait: 0, action: { ...off }, continue: 'none', cancels: mine.map((c) => c.id) });
    cues.push(...mine);
  }
  return cues;
}

const layerIds = (a) => (Array.isArray(a.layerIds) && a.layerIds.length ? a.layerIds : a.layerId ? [a.layerId] : []);

/**
 * Add the cues that run the panelists to a cue list:
 *   Reader into B          question goes live → reader into slot B of the 1-panelist layout,
 *                          then (auto-follow) the existing "question goes live" cue
 *   Question overlay off   first panelist starts answering → the question overlay layers off
 *   Panelist layout        panelists answering change → layout, sources, set
 *   Panelist name (+ off)  after the delay → lower third; off again after the set time
 *   Panelists done         last panelist stops → lower third off, stops the chain above
 */
export function addPanelistCues(cues, { panelists = {}, overlayLayers = [] } = {}) {
  const id = () => Math.random().toString(36).slice(2, 10);
  const base = { preWait: 0, continue: 'none', cancels: [] };
  const list = cues.map((c) => ({ ...c }));
  const lt = panelists.ltLayerId;
  const off = Number(panelists.ltOffAfterSec) || 0;
  const rows = panelists.layouts || [];
  const layout1 = rows.find((l) => l.count === 1 && (l.shot || 'host') === 'host');
  if (layout1?.layerId) {
    const reader = { ...base, id: id(), name: 'Reader into B', trigger: { type: 'mukana', event: 'questionLive' }, action: { type: 'roleToSlot', role: 'reader', layerId: layout1.layerId, slot: 'B' } };
    const q = list.findIndex((c) => c.trigger?.type === 'mukana' && c.trigger.event === 'questionLive');
    if (q >= 0) {
      // The reader's source must be in place before the question cue recalls the layout.
      reader.continue = 'auto-follow';
      list[q] = { ...list[q], trigger: { type: 'none' } };
      list.splice(q, 0, reader);
    } else list.push(reader);
  }
  if (overlayLayers.length) list.push({ ...base, id: id(), name: 'Question overlay off', trigger: { type: 'mukana', event: 'answeringStart' }, action: { type: 'layerOff', layerIds: overlayLayers } });
  // The panelist layout takes over from the question flow: it stops the question cues and
  // everything chained after them (e.g. an auto-off that would recall another layout later).
  const questionFlow = [];
  list.forEach((c, i) => {
    if (c.trigger?.type !== 'mukana' || c.trigger.event !== 'questionLive') return;
    for (let j = i; j < list.length; j++) {
      questionFlow.push(list[j].id);
      if (list[j].continue === 'none' || !list[j].continue) break;
    }
  });
  // Each panelist: with host at 0 s, name after the delay, answering only a few seconds later,
  // name off after the off time. Auto-continue = one timeline; every new panelist restarts it.
  const delay = Number(panelists.ltDelaySec) || 0;
  const solo = rows.some((l) => l.shot === 'solo');
  const chain = [{ ...base, id: id(), name: 'Answering · with host', trigger: { type: 'mukana', event: 'answeringChange' }, action: { type: 'panelistLayout', shot: 'host' }, cancels: [...new Set(questionFlow)] }];
  if (lt) chain.push({ ...base, id: id(), name: 'Panelist name', trigger: { type: 'none' }, preWait: delay, action: { type: 'panelistLowerThird' } });
  if (solo) chain.push({ ...base, id: id(), name: 'Go single', trigger: { type: 'none' }, preWait: Math.max(delay + 3, 6), action: { type: 'changeShot', shot: 'solo' } });
  if (lt && off > 0) chain.push({ ...base, id: id(), name: 'Panelist name off', trigger: { type: 'none' }, preWait: delay + off, action: { type: 'layerOff', layerIds: [lt] } });
  chain.forEach((c, i) => (c.continue = i < chain.length - 1 ? 'auto-continue' : 'none'));
  list.push(...chain);
  if (lt) list.push({ ...base, id: id(), name: 'Panelists done', trigger: { type: 'mukana', event: 'answeringEnd' }, action: { type: 'layerOff', layerIds: [lt] }, cancels: chain.map((c) => c.id) });
  // Shot buttons for the Stream Deck.
  const shots = [['host', 'Shot: with host'], ...(solo ? [['solo', 'Shot: answering only']] : []), ...(rows.some((l) => l.shot === 'hostOnly') ? [['hostOnly', 'Shot: host only']] : [])];
  for (const [shot, name] of shots) list.push({ ...base, id: id(), name, trigger: { type: 'go' }, action: { type: 'changeShot', shot } });
  return list;
}

/**
 * The question overlay: layers the question cue's set takes live that neither the 1-panelist
 * layout set nor the question-done set keeps live. Falls back to layers with mapped question text.
 */
export function overlayLayersFrom({ cues = [], panelists = {}, targets = [], sets = [] }) {
  const live = (id) => new Set((sets.find((s) => s.id === id)?.layers || []).filter((l) => l.action === 'live').map((l) => l.id));
  const qSet = cues.find((c) => c.trigger?.event === 'questionLive' && c.action?.type === 'recallSet')?.action.setId;
  const doneSet = cues.find((c) => c.trigger?.event === 'questionDone' && c.action?.type === 'recallSet')?.action.setId;
  const keep = new Set([...live((panelists.layouts || []).find((l) => l.count === 1)?.setId), ...live(doneSet)]);
  const fromSets = [...live(qSet)].filter((id) => !keep.has(id));
  if (fromSets.length) return fromSets;
  return [...new Set(targets.filter((t) => t.kind === 'layer' && QUESTION_FIELDS.has(t.field)).map((t) => t.id))];
}

export class CueEngine {
  constructor(engine) {
    this.engine = engine;
    this.last = new Map(); // cue id -> latest instance (it may have finished but still own a chain)
    this.cueLive = new Set(); // layers cues have taken live
    this.holds = new Map(); // layer id -> { values, seq }: question text held at what is on air
    this.sourceHold = null;
    this.sets = null; // layer set id -> { name, live: [], off: [] }
    this.seq = 0;
    this.instSeq = 0;
    this.primed = false;
    this.signature = '';
  }

  get cfg() {
    return this.engine.getConfig();
  }

  cues() {
    return this.cfg.layerControl?.cues || [];
  }

  enabled() {
    return !!this.cfg.layerControl?.enabled;
  }

  /** A cue by id, or by number as shown in the list (1-based). */
  find(ref) {
    const list = this.cues();
    return list.find((c) => c.id === String(ref)) || (/^\d+$/.test(String(ref)) ? list[Number(ref) - 1] : undefined);
  }

  number(cue) {
    return this.cues().indexOf(cue) + 1;
  }

  label(cue) {
    return `${this.number(cue)} ${cue.name || ACTIONS[cue.action?.type] || 'Cue'}`;
  }

  log(msg, level = 'info') {
    this.engine.addLog(level, `Cue ${msg}`);
  }

  prime() {
    this.reset();
    this.primed = true;
    this.signature = this.sig();
    this.loadSets();
  }

  reset() {
    this.stopAll(false);
    this.holds.clear();
    this.sourceHold = null;
    this.cueLive.clear();
    this.primed = false;
  }

  sig() {
    return JSON.stringify([this.cues(), this.enabled()]);
  }

  configure() {
    if (this.sig() === this.signature) return;
    const wasOn = JSON.parse(this.signature || '[[],false]')[1];
    this.signature = this.sig();
    if (wasOn && !this.enabled()) this.stopAll();
    for (const [id, inst] of this.last) if (!this.find(id)) this.stop(inst); // removed cues
    this.loadSets();
  }

  async loadSets() {
    try {
      const ml = new MimoLive(this.cfg.mimolive);
      const layers = await ml.layers(this.cfg.mimolive.documentId).catch(() => []);
      this.layerNames = new Map(layers.map((l) => [l.id, l.name]));
      const sets = await ml.layerSets(this.cfg.mimolive.documentId);
      const by = (s, action) => s.layers.filter((l) => l.action === action).map((l) => l.id);
      this.sets = new Map(sets.map((s) => [s.id, { name: s.name, live: by(s, 'live'), off: [...by(s, 'off'), ...by(s, 'force-off')] }]));
    } catch {
      /* fixed waits instead */
    }
  }

  async setInfo(id) {
    if (!this.sets?.has(id)) await this.loadSets();
    return this.sets?.get(id) || { name: id, live: [], off: [] };
  }

  // ---------- question text timing ----------

  /** Called synchronously after Mukana data changed and before the text is pushed. */
  beforePush(prev, events) {
    if (!this.primed || !this.enabled() || !events.some((e) => e.startsWith('question'))) return;
    if (!this.cues().some((c) => c.trigger?.type === 'mukana' && events.includes(c.trigger.event))) return;
    const seq = ++this.seq;
    for (const t of this.cfg.targets) {
      if (t.kind === 'layer' && QUESTION_FIELDS.has(t.field) && this.cueLive.has(t.id) && !this.holds.has(t.id)) this.holds.set(t.id, { values: { ...prev.values }, seq });
    }
    if (this.holds.size && !this.sourceHold) this.sourceHold = { values: { ...prev.values }, seq };
  }

  /** Value to send to mapping target `t`, or undefined when nothing holds it. */
  held(t) {
    if (!QUESTION_FIELDS.has(t.field)) return undefined;
    if (t.kind === 'layer' && this.holds.has(t.id)) return this.holds.get(t.id).values[t.field] ?? '';
    if (t.kind === 'source' && this.sourceHold) return this.sourceHold.values[t.field] ?? '';
    return undefined;
  }

  async release(layers) {
    let changed = false;
    for (const id of layers) changed = this.holds.delete(id) || changed;
    if (!this.holds.size) (changed = changed || !!this.sourceHold), (this.sourceHold = null);
    if (changed) await this.engine.push();
  }

  releaseSeq(seq) {
    return this.release([...this.holds].filter(([, h]) => h.seq <= seq).map(([id]) => id));
  }

  /** Layers about to go live that hold old text: out first, then the new text. */
  async beforeLive(ml, doc, layers) {
    const held = layers.filter((id) => this.holds.has(id));
    if (!held.length) return;
    const states = await Promise.all(held.map((id) => ml.layerState(doc, id).catch(() => 'off')));
    const onAir = held.filter((id, i) => !OFF_STATES.has(states[i]));
    if (onAir.length) {
      await Promise.all(onAir.map((id) => ml.setOff(doc, id)));
      if (!(await waitOff(ml, doc, onAir))) this.log('text layers still not off after 5 s, continuing', 'error');
    }
    await this.release(held);
  }

  /** Layers just taken off: clear their held text once they are off. */
  async afterOff(ml, doc, layers) {
    if (!layers.length) return sleep(SET_FALLBACK_MS);
    if (!(await waitOff(ml, doc, layers))) this.log('layers still not off after 5 s, continuing', 'error');
    layers.forEach((id) => this.cueLive.delete(id));
    await this.release(layers.filter((id) => this.holds.has(id)));
  }

  // ---------- running cues ----------

  /** Mukana events (real or simulated). */
  onEvents(events) {
    if (!this.primed || !this.enabled()) return;
    // Paused cues waiting for one of these events continue first.
    for (const inst of this.last.values()) {
      if (this.paused(inst) && events.includes(inst.until)) {
        this.log(`${this.label(inst.cue)} · continue (${EVENTS[inst.until]})`);
        inst.release();
      }
    }
    const seq = this.seq;
    const roots = [];
    for (const e of events) {
      for (const cue of this.cues().filter((c) => c.trigger?.type === 'mukana' && c.trigger.event === e)) roots.push(this.fire(cue, null, EVENTS[e]));
    }
    // Text no triggered cue took care of is released when their actions are done.
    Promise.allSettled(roots.map((r) => r.actionDone)).then(() => this.releaseSeq(seq));
  }

  /** GO from the UI or Companion. Works even with Auto layers off. */
  /** GO from the UI or Companion: continues the cue if it is paused, else fires it. */
  go(ref) {
    const cue = this.find(ref);
    if (!cue) throw new Error(`No cue ${ref}`);
    if (this.paused(this.last.get(cue.id))) return this.continueCue(ref, 'GO');
    this.fire(cue, null, 'GO');
    return this.status();
  }

  fire(cue, parent, why) {
    const prev = this.last.get(cue.id);
    if (prev) this.stop(prev); // restart: also stops what it started
    for (const ref of cue.cancels || []) {
      const c = this.find(ref);
      const inst = c && this.last.get(c.id);
      if (inst && c !== cue) this.stop(inst);
    }
    const inst = { id: ++this.instSeq, cue, parent, children: new Set(), timers: new Set(), stopped: false, done: false, phase: 'pre-wait', endsAt: null };
    let markActionDone;
    inst.actionDone = new Promise((r) => (markActionDone = r));
    parent?.children.add(inst);
    this.last.set(cue.id, inst);
    this.run(inst, why)
      .catch((e) => this.log(`${this.label(cue)}: ${e.message}`, 'error'))
      .finally(() => {
        markActionDone();
        inst.done = true;
        inst.phase = inst.stopped ? 'stopped' : 'done';
        inst.endsAt = null;
        this.engine.emit('status');
      });
    return inst;
  }

  async run(inst, why) {
    const cue = inst.cue;
    this.log(`${this.label(cue)} · GO${why ? ` (${why})` : ''}`);
    const next = this.cues()[this.number(cue)];
    // Timeline: the next cue starts now too; its own pre-wait counts from this moment.
    if (cue.continue === 'auto-continue' && next) this.fire(next, inst, `with ${this.number(cue)}`);
    const pre = Number(cue.preWait) || 0;
    if (pre > 0) await this.wait(inst, pre);
    if (inst.stopped) return;
    inst.phase = 'acting';
    await this.act(inst);
    inst.acted = true;
    if (inst.stopped) return;
    if (cue.continue === 'auto-follow' && next) this.fire(next, inst, `after ${this.number(cue)}`);
  }

  /**
   * Wait `seconds`, or pause until `until` ('go' = GO / Continue, or a Mukana event) releases it.
   * With `until`, seconds > 0 is a timeout; 0 waits for the release only.
   */
  wait(inst, seconds, until = '') {
    inst.phase = until ? 'paused' : 'waiting';
    inst.until = until || null;
    inst.endsAt = seconds > 0 ? Date.now() + seconds * 1000 : null;
    return new Promise((resolve) => {
      const h = {
        t: null,
        resolve: () => {
          clearTimeout(h.t);
          inst.timers.delete(h);
          inst.release = null;
          inst.until = null;
          resolve();
        },
      };
      if (seconds > 0 || !until) h.t = setTimeout(h.resolve, Math.max(0, seconds) * 1000);
      if (until) inst.release = h.resolve;
      inst.timers.add(h);
    });
  }

  paused(inst) {
    return !!inst && !inst.done && !inst.stopped && !!inst.release;
  }

  /** Release a paused cue (GO on a paused cue, Companion "continue", or its Mukana event). */
  continueCue(ref, why = 'Continue') {
    const cue = this.find(ref);
    if (!cue) throw new Error(`No cue ${ref}`);
    const inst = this.last.get(cue.id);
    if (!this.paused(inst)) throw new Error(`Cue ${this.number(cue)} is not paused`);
    this.log(`${this.label(cue)} · continue (${why})`);
    inst.release();
    return this.status();
  }

  async act(inst) {
    const a = inst.cue.action || {};
    const ml = new MimoLive(this.cfg.mimolive);
    const doc = this.cfg.mimolive.documentId;
    const say = (msg) => this.log(`${this.label(inst.cue)} → ${msg}`);
    switch (a.type) {
      case 'recallSet': {
        const info = await this.setInfo(a.setId);
        await this.beforeLive(ml, doc, info.live);
        if (inst.stopped) return;
        await ml.recallLayerSet(doc, a.setId);
        say(`recall “${info.name}”`);
        info.live.forEach((id) => this.cueLive.add(id));
        const goingOff = info.off.filter((id) => this.holds.has(id) || this.cueLive.has(id));
        if (goingOff.length) await this.afterOff(ml, doc, goingOff);
        return;
      }
      case 'layerLive': {
        const ids = layerIds(a);
        await this.beforeLive(ml, doc, ids);
        if (inst.stopped) return;
        await Promise.all(ids.map((id) => ml.setLive(doc, id)));
        ids.forEach((id) => this.cueLive.add(id));
        return say(`${ids.map((id) => this.layerName(id)).join(', ')} live`);
      }
      case 'layerOff': {
        const ids = layerIds(a);
        await Promise.all(ids.map((id) => ml.setOff(doc, id)));
        say(`${ids.map((id) => this.layerName(id)).join(', ')} off`);
        if (ids.includes(this.cfg.panelists?.ltLayerId)) this.engine.panelists.ltLive = null;
        return this.afterOff(ml, doc, ids);
      }
      case 'panelLayout':
        return say(`panel layout: ${await this.engine.panelists.applyLayout(ml, doc, 'panel')}`);
      case 'panelistLayout':
        return say(`answering layout (${SHOTS[a.shot || 'host']}): ${await this.engine.panelists.applyLayout(ml, doc, 'answering', a.shot || 'host')}`);
      case 'changeShot':
        return say(`shot ${SHOTS[a.shot] || a.shot}: ${await this.engine.panelists.changeShot(ml, doc, a.shot)}`);
      case 'panelistLowerThird':
        return say(`panelist lower third: ${await this.engine.panelists.showLowerThird(ml, doc)}`);
      case 'sourceToSlot':
        await ml.setInput({ documentId: doc, kind: 'layer', id: a.layerId, key: slotKey(a.slot), value: a.sourceId });
        return say(`${this.layerName(a.layerId)} slot ${a.slot} ← source`);
      case 'roleToSlot': {
        const p = this.engine.panelists.personWithRole(a.role);
        if (!p?.sourceId) return say(`nobody with the role ${a.role} and a video source in the People table`);
        await ml.setInput({ documentId: doc, kind: 'layer', id: a.layerId, key: slotKey(a.slot), value: p.sourceId });
        return say(`${this.layerName(a.layerId)} slot ${a.slot} ← ${p.screenName || p.name} (${a.role})`);
      }
      case 'setLayersOff': {
        const info = await this.setInfo(a.setId);
        await Promise.all(info.live.map((id) => ml.setOff(doc, id)));
        say(`layers of “${info.name}” off`);
        return this.afterOff(ml, doc, info.live);
      }
      case 'writeText': {
        // {field} is replaced by the current Mukana value, e.g. "{name}, {location}"
        const value = String(a.value ?? '').replace(/\{(\w+)\}/g, (m, f) => this.engine.current.values[f] ?? m);
        await ml.setInput({ documentId: doc, kind: a.kind || 'layer', id: a.targetId, key: a.key, value });
        return say(`text “${value.slice(0, 40)}”`);
      }
      case 'signal':
        await ml.signal(doc, a.layerId, a.signalId);
        return say(`signal ${a.signalId.replace(/^tvGroup_\w+__/, '').replace(/_TypeSignal$/, '')}`);
      case 'wait':
        if (a.until) say(`paused until ${a.until === 'go' ? 'GO / Continue' : EVENTS[a.until] || a.until}${Number(a.seconds) > 0 ? ` (max ${a.seconds} s)` : ''}`);
        await this.wait(inst, Number(a.seconds) || 0, a.until || '');
        return;
      case 'fireCue': {
        const target = this.find(a.cueId);
        if (target && target !== inst.cue) this.fire(target, inst, `from ${this.number(inst.cue)}`);
        return;
      }
      default:
        return;
    }
  }

  layerName(id) {
    return this.layerNames?.get(id) || String(id).slice(0, 8);
  }

  /** Stop an instance and everything it started. */
  stop(inst) {
    if (!inst.stopped && !inst.done && !inst.acted) this.log(`${this.label(inst.cue)} · stopped`);
    inst.stopped = true;
    for (const h of inst.timers) clearTimeout(h.t), h.resolve();
    inst.timers.clear();
    for (const child of inst.children) this.stop(child);
  }

  stopAll(releaseText = true) {
    for (const inst of this.last.values()) this.stop(inst);
    this.last.clear();
    if (releaseText && (this.holds.size || this.sourceHold)) {
      this.holds.clear();
      this.sourceHold = null;
      this.engine.push();
    }
  }

  stopCue(ref) {
    const cue = this.find(ref);
    if (!cue) throw new Error(`No cue ${ref}`);
    const inst = this.last.get(cue.id);
    if (inst) this.stop(inst);
    return this.status();
  }

  status() {
    return this.cues().map((c, i) => {
      const inst = this.last.get(c.id);
      const running = !!inst && !inst.done && !inst.stopped;
      return { id: c.id, number: i + 1, name: c.name || '', running, phase: running ? inst.phase : 'idle', endsAt: running ? inst.endsAt : null, until: running ? inst.until : null };
    });
  }
}
