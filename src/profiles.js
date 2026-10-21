// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Ronny Hofsøy, Media Event AS
// Show profiles: everything that belongs to one show, saved as data/profiles/<name>.json.
// In a profile: Mukana event ID and login (refresh token), mimoLive host/port/document, mapping,
// cue list, panelists. Not in a profile (this machine): mimoLive password, Firebase settings,
// web UI address, start at login. Profile files are readable by this user only; a download
// leaves the token out unless asked for.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DEFAULTS } from './config.js';

const DIR = path.join(DATA_DIR, 'profiles');
export const PROFILE_VERSION = 1;

/** "Rabalder 2026 – day 1" → "rabalder-2026-day-1" */
export function slug(name) {
  return String(name).replace(/[øØ]/g, 'o').replace(/[æÆ]/g, 'ae').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/** The show part of a config. */
export function showOf(cfg) {
  return structuredClone({
    mukana: { eventId: cfg.mukana.eventId, refreshToken: cfg.mukana.refreshToken || '' },
    mimolive: { host: cfg.mimolive.host, port: cfg.mimolive.port, documentId: cfg.mimolive.documentId },
    targets: cfg.targets,
    layerControl: { cues: cfg.layerControl.cues || [] },
    panelists: cfg.panelists,
  });
}

/** An empty show (Reset). The mimoLive host stays, so a new show starts on the same machine. */
export function blankShow(cfg) {
  return {
    mukana: { eventId: '' }, // no token: the current login is kept
    mimolive: { host: cfg.mimolive.host, port: cfg.mimolive.port, documentId: '' },
    targets: [],
    layerControl: { cues: [] },
    panelists: structuredClone(DEFAULTS.panelists),
  };
}

/** Put a show into a config. Auto layers goes off, so a loaded show never fires by itself. */
export function applyShow(cfg, show, name = '') {
  const s = structuredClone(show);
  cfg.mukana.eventId = s.mukana?.eventId ?? '';
  if (s.mukana?.refreshToken) cfg.mukana.refreshToken = s.mukana.refreshToken; // else keep the current login
  cfg.mimolive = { ...cfg.mimolive, host: s.mimolive?.host || cfg.mimolive.host, port: s.mimolive?.port || cfg.mimolive.port, documentId: s.mimolive?.documentId ?? '' };
  cfg.targets = Array.isArray(s.targets) ? s.targets : [];
  cfg.layerControl = { ...cfg.layerControl, cues: s.layerControl?.cues || [], enabled: false, panelistCuesAdded: true };
  delete cfg.layerControl.rules;
  cfg.panelists = { ...structuredClone(DEFAULTS.panelists), ...(s.panelists || {}) };
  cfg.profile = name;
  return cfg;
}

const file = (name) => path.join(DIR, `${slug(name)}.json`);

function read(name) {
  const f = file(name);
  if (!slug(name) || !fs.existsSync(f)) throw new Error(`No profile “${name}”`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

export function list() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      return { name: p.name, savedAt: p.savedAt, eventId: p.show?.mukana?.eventId || '', hasToken: !!p.show?.mukana?.refreshToken, cues: p.show?.layerControl?.cues?.length || 0, people: p.show?.panelists?.cast?.length || 0 };
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** The saved file for a profile (download). The login token only when asked for. */
export function exportProfile(name, { withToken = false } = {}) {
  const doc = read(name);
  if (!withToken && doc.show?.mukana) delete doc.show.mukana.refreshToken;
  return doc;
}

export function save(cfg, name) {
  name = String(name || '').trim();
  if (!slug(name)) throw new Error('Give the profile a name');
  fs.mkdirSync(DIR, { recursive: true });
  const doc = { app: 'mukana-mimolive-sync', version: PROFILE_VERSION, name, savedAt: new Date().toISOString(), show: showOf(cfg) };
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 }); // holds the login token
  fs.renameSync(tmp, file(name));
  return doc;
}

/** Store an uploaded profile file as it is (same name = replaced). */
export function saveDoc(doc) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file(doc.name), JSON.stringify(doc, null, 2), { mode: 0o600 });
  return doc;
}

export function load(name) {
  return read(name);
}

export function remove(name) {
  const f = file(name);
  if (!fs.existsSync(f)) throw new Error(`No profile “${name}”`);
  fs.unlinkSync(f);
}

/** Check an uploaded profile file. Returns the document. */
export function parseUpload(doc) {
  if (!doc || doc.app !== 'mukana-mimolive-sync' || !doc.show) throw new Error('Not a show profile from Mukana → mimoLive Sync');
  if (!slug(doc.name)) throw new Error('The profile has no name');
  return doc;
}

/** Has the show changed since the profile was loaded or saved? */
export function modified(cfg) {
  if (!cfg.profile) return null;
  try {
    return JSON.stringify(showOf(cfg)) !== JSON.stringify(read(cfg.profile).show);
  } catch {
    return null;
  }
}
