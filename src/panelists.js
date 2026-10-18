// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Ronny Hofsøy, Media Event AS
// Panelists: the people table (role, video source, lower third), the layouts table and the
// pre-flight list. Nothing here runs by itself: the cue list decides when, with these actions:
//   Panel layout          the panel for this question: everyone approved above the line (and
//                         anyone answering), in queue order → layout row for that many → their
//                         sources into the slots (B, C, …; the host stays in A) → recall the set.
//   Answering layout      the same, but only who is answering now, in a shot: with host,
//                         answering only, or the current shot. When one leaves, the others
//                         shift up. Nobody answering: nothing changes.
//   Change shot           with host / answering only / host only, right away. With host and
//                         answering only become the current shot; host only is momentary.
// Layout rows have a shot: 'host' (with host, the default), 'solo' (answering only) or
// 'hostOnly' (count 0: the host alone).
//   Panelist lower third  with exactly one panelist who is new in that position: their name and
//                         title (or their own variant) into the lower third, then live.
//   Role into slot        the person with a role (e.g. reader) into a slot.
// Roles: the host never counts. The reader counts as a panelist only while answering.
import { MimoLive } from './mimolive.js';
import { waitOff } from './cues.js';
import { findQuestions, handsPeople } from './sync.js';

// Panelists raise their hand on this question when they join (text match, case-insensitive).
export const DEFAULT_ROSTER_MATCH = 'Pre-flight checklist';

export const slotKey = (slot) => `tvIn_VideoSource${slot}Image`;
export const LT_NAME_KEY = 'tvGroup_Content__Title';
export const LT_TITLE_KEY = 'tvGroup_Content__Subtitle';
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export class PanelistController {
  constructor(engine) {
    this.engine = engine;
    this.placed = []; // uids in slot order, as last placed by a layout action
    this.mode = null; // 'panel' | 'answering': which layout action placed them
    this.layoutKey = null; // shot:count of the layout row on air
    this.shot = 'host'; // what is on screen: 'host' | 'solo' | 'hostOnly'
    this.answerShot = 'host'; // the current shot for answering ("Current shot")
    this.shotQuestion = null; // the question answerShot belongs to (reset to with host per question)
    this.ltFor = null; // who the next "Panelist lower third" is for
    this.ltLive = null; // whose lower third is on air
    this.primed = false;
  }

  get cfg() {
    return this.engine.getConfig();
  }

  get settings() {
    return this.cfg.panelists || {};
  }

  cast(uid) {
    return (this.settings.cast || []).find((c) => c.uid === uid);
  }

  role(uid) {
    return this.cast(uid)?.role || 'panelist';
  }

  /** Who counts as answering: everyone answering except the host (a reader answering counts). */
  countable(answering = []) {
    return answering.filter((p) => this.role(p.uid) !== 'host');
  }

  wanted() {
    return this.countable(this.engine.current.answering).map((p) => p.uid);
  }

  /** The panel: approved above the line or answering, host excluded, in queue order. */
  panelUids() {
    return this.countable(this.engine.current.panel).map((p) => p.uid);
  }

  /** Layout row for `n` people in a shot: exact match, else the largest smaller one. */
  layoutFor(n, shot = 'host') {
    const rows = [...(this.settings.layouts || [])].filter((l) => (l.shot || 'host') === shot && l.count >= 1).sort((a, b) => a.count - b.count);
    return rows.find((l) => l.count === n) || rows.filter((l) => l.count < n).at(-1) || null;
  }

  hostOnlyRow() {
    return (this.settings.layouts || []).find((l) => l.shot === 'hostOnly') || null;
  }

  nameOf(uid) {
    const cur = this.engine.current;
    return [...(cur.answering || []), ...(cur.panel || [])].find((p) => p.uid === uid)?.name || this.cast(uid)?.screenName || this.cast(uid)?.name || uid;
  }

  /** Start from what is in Mukana now, without touching mimoLive. */
  prime() {
    this.reset();
    this.placed = this.wanted();
    this.mode = this.placed.length ? 'answering' : null;
    const row = this.placed.length ? this.layoutFor(this.placed.length) : null;
    this.layoutKey = row ? `host:${row.count}` : null;
    this.primed = true;
  }

  reset() {
    this.placed = [];
    this.mode = null;
    this.layoutKey = null;
    this.shot = 'host';
    this.answerShot = 'host';
    this.shotQuestion = null;
    this.ltFor = null;
    this.ltLive = null;
    this.primed = false;
  }

  log(msg, level = 'info') {
    this.engine.addLog(level, `Panelists: ${msg}`);
  }

  // ---------- cue actions ----------

  /**
   * "Panel layout" (mode 'panel') or "Answering layout" (mode 'answering').
   * Going from one to the other always counts as a new layout. Returns a description for the log.
   */
  async applyLayout(ml, doc, mode = 'answering', shotSetting = 'host') {
    const want = mode === 'panel' ? this.panelUids() : this.wanted();
    if (this.mode !== mode) {
      this.placed = [];
      this.layoutKey = null;
      this.mode = mode;
    }
    // The panel is always with host. Answering: the chosen shot, or the current one (reset per question).
    if (this.shotQuestion !== this.engine.current.key) (this.shotQuestion = this.engine.current.key), (this.answerShot = 'host');
    let shot = mode === 'panel' ? 'host' : shotSetting === 'current' ? this.answerShot : shotSetting;
    if (mode === 'answering') this.answerShot = shot;
    const prev = this.placed;
    // Keep the positions of those still there (shifting up), newcomers at the end.
    const next = [...prev.filter((u) => want.includes(u)), ...want.filter((u) => !prev.includes(u))];
    // A lower third only for one answering panelist who is new in that position.
    this.ltFor = mode === 'answering' && next.length === 1 && (prev.length === 0 || (prev.length === 1 && prev[0] !== next[0])) ? next[0] : null;
    let layout = next.length ? this.layoutFor(next.length, shot) : null;
    if (next.length && !layout && shot !== 'host') {
      this.log(`no "${shot === 'solo' ? 'answering only' : shot}" layout for ${next.length}, using with host`, 'error');
      shot = 'host';
      layout = this.layoutFor(next.length, shot);
    }
    const key = layout ? `${shot}:${layout.count}` : null;
    if (same(next, prev) && key && this.layoutKey === key && this.shot === shot) return 'no change';
    if (this.ltLive && !(next.length === 1 && next[0] === this.ltLive)) await this.lowerThirdOff(ml, doc); // before the source changes under it
    this.placed = next;
    if (!next.length) {
      this.layoutKey = null; // the layout stays on air; recalled again next time
      return mode === 'panel' ? 'nobody above the line, layout stays' : 'nobody answering, layout stays';
    }
    if (!layout) {
      this.log(`no layout for ${next.length} panelist(s)`, 'error');
      return 'no layout';
    }
    if (layout.count !== next.length) this.log(`no layout for ${next.length}, using the one for ${layout.count}`, 'error');
    const changed = this.layoutKey !== key || this.shot !== shot;
    // Sources first, so the layout comes up with the right people in it.
    for (const [i, uid] of next.entries()) {
      const slot = layout.slots[i];
      if (!slot || (!changed && prev[i] === uid)) continue;
      const c = this.cast(uid);
      if (!c?.sourceId) {
        this.log(`${this.nameOf(uid)} has no video source in the People table`, 'error');
        continue;
      }
      if (layout.layerId) await ml.setInput({ documentId: doc, kind: 'layer', id: layout.layerId, key: slotKey(slot), value: c.sourceId });
    }
    if (changed && layout.setId) await ml.recallLayerSet(doc, layout.setId);
    this.layoutKey = key;
    this.shot = shot;
    return `${next.map((u, i) => `${this.nameOf(u)} → ${layout.slots[i] || '–'}`).join(', ')}${changed ? ` · ${layout.setName || 'layout'}` : ''}`;
  }

  /** "Change shot": 'host' | 'solo' | 'hostOnly', right away. */
  async changeShot(ml, doc, shot) {
    if (shot === 'hostOnly') {
      const row = this.hostOnlyRow();
      if (!row?.setId) return 'no "host only" row in the layouts table';
      if (this.ltLive) await this.lowerThirdOff(ml, doc); // their name without them on screen
      await ml.recallLayerSet(doc, row.setId);
      this.shot = 'hostOnly';
      this.layoutKey = null; // the next layout recalls its set again
      return `host only · ${row.setName || 'layout'}`;
    }
    if (this.shotQuestion !== this.engine.current.key) (this.shotQuestion = this.engine.current.key), (this.answerShot = 'host');
    this.answerShot = shot;
    if (!this.wanted().length) return `${shot === 'solo' ? 'answering only' : 'with host'} (used for the next panelist)`;
    return this.applyLayout(ml, doc, 'answering', shot);
  }

  /** "Panelist lower third". */
  async showLowerThird(ml, doc) {
    const s = this.settings;
    const uid = this.ltFor;
    if (!uid || !this.placed.includes(uid) || this.placed.length !== 1) return 'skipped (not one new panelist)';
    if (!s.ltLayerId) return 'skipped (no lower third layer in 5 · Panelists)';
    const c = this.cast(uid);
    if ((s.ltMode || 'text') === 'text') {
      await ml.setInput({ documentId: doc, kind: 'layer', id: s.ltLayerId, key: s.ltNameKey || LT_NAME_KEY, value: c?.screenName || this.nameOf(uid) });
      await ml.setInput({ documentId: doc, kind: 'layer', id: s.ltLayerId, key: s.ltTitleKey || LT_TITLE_KEY, value: c?.title || '' });
      await ml.setLive(doc, s.ltLayerId);
    } else {
      if (!c?.ltVariantId) return `skipped (${this.nameOf(uid)} has no variant)`;
      await ml.setVariantLive(doc, s.ltLayerId, c.ltVariantId);
    }
    this.ltFor = null;
    this.ltLive = uid;
    return `${this.nameOf(uid)} live`;
  }

  /** Lower third off, waiting for its out-animation. */
  async lowerThirdOff(ml, doc) {
    const layer = this.settings.ltLayerId;
    this.ltLive = null;
    if (!layer) return;
    await ml.setOff(doc, layer);
    if (!(await waitOff(ml, doc, [layer]))) this.log('lower third still not off after 5 s, continuing', 'error');
  }

  /** "Role into slot": the (first) person with this role. */
  personWithRole(role) {
    return (this.settings.cast || []).find((c) => c.uid && (c.role || 'panelist') === role);
  }

  // ---------- pre-flight list ----------

  /**
   * Remember everyone who raised a hand on the pre-flight question. Mukana drops the hands
   * once the question is answered, so they are kept in the config (per event).
   */
  captureRoster(trees) {
    const keys = findQuestions(trees, this.cfg.panelists?.rosterMatch ?? DEFAULT_ROSTER_MATCH);
    const added = this.mergeRoster(keys.flatMap((k) => handsPeople(trees.hands?.[k], trees.online)));
    if (added.length) this.log(`${this.roster().length} on the pre-flight list`);
  }

  /**
   * For people who arrive after the pre-flight question is done: add everyone with a hand on
   * the live question to the list. Returns everyone on that question.
   */
  addFromCurrentQuestion(trees) {
    const key = trees.liveQ?.key;
    if (!key) throw new Error('No question is live in Mukana');
    const people = handsPeople(trees.hands?.[key], trees.online);
    const added = this.mergeRoster(people);
    this.log(`${people.length} on the live question, ${added.length} new on the list`);
    return { people, added };
  }

  /** Add people to this event's list (and refresh names). Returns the ones that were new. */
  mergeRoster(people) {
    const cfg = this.cfg;
    const ev = cfg.mukana.eventId;
    cfg.panelists ||= {};
    let r = cfg.panelists.roster;
    if (!r || r.eventId !== ev) r = { eventId: ev, people: [] };
    let changed = r !== cfg.panelists.roster;
    const added = [];
    for (const p of people) {
      const have = r.people.find((x) => x.uid === p.uid);
      if (!have) r.people.push(p), added.push(p), (changed = true);
      else {
        if (p.name !== p.uid && have.name !== p.name) (have.name = p.name), (changed = true);
        if (p.loc && have.loc !== p.loc) (have.loc = p.loc), (changed = true);
      }
    }
    if (changed) {
      cfg.panelists.roster = r;
      this.engine.emit('configChanged');
    }
    return added;
  }

  /** Panelists to pick from: the pre-flight list for this event. */
  roster() {
    const r = this.settings.roster;
    return r && r.eventId === this.cfg.mukana.eventId ? r.people : [];
  }

  status() {
    const [shot, count] = (this.layoutKey || '').split(':');
    const layout = count ? this.layoutFor(Number(count), shot) : null;
    return {
      shot: this.shot,
      answerShot: this.answerShot,
      answering: this.wanted().map((uid) => ({ uid, name: this.nameOf(uid), role: this.role(uid) })),
      panel: this.panelUids().map((uid) => ({ uid, name: this.nameOf(uid) })),
      mode: this.mode,
      placed: this.placed.map((uid, i) => ({ uid, name: this.nameOf(uid), slot: layout?.slots[i] || null })),
      lowerThird: this.ltLive ? { name: this.nameOf(this.ltLive), phase: 'live' } : null,
    };
  }
}
