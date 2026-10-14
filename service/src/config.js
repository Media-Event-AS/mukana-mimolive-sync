// Persistent configuration (data/config.json). Written atomically.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'config.json');

export const FIELDS = [
  { id: 'name', label: 'Navn', defaultKey: 'tvGroup_Content__Text_TypeMultiline' },
  { id: 'question', label: 'Spørsmål (uten URL)', defaultKey: 'tvGroup_Content__Text_TypeMultiline' },
  { id: 'location', label: 'Sted', defaultKey: 'tvGroup_Content__Text_TypeMultiline' },
  { id: 'tag', label: 'Tag', defaultKey: 'tvGroup_Content__Text_TypeMultiline' },
  { id: 'votes', label: 'Stemmer', defaultKey: 'tvGroup_Content__Text_TypeMultiline' },
  { id: 'url', label: 'URL i spørsmålet (QR)', defaultKey: 'tvGroup_Content__QR_Content' },
  { id: 'queue', label: 'Panelist-kø (i kø)', defaultKey: 'tvGroup_Note__Note_TypeMultiline' },
  { id: 'activePanelist', label: 'Aktiv panelist', defaultKey: 'tvGroup_Content__Text_TypeMultiline' },
  { id: 'questionFull', label: 'Spørsmål (original)', defaultKey: 'tvGroup_Content__Text_TypeMultiline' },
];

export const DEFAULTS = {
  mukana: {
    eventId: '',
    refreshToken: '',
    apiKey: 'AIzaSyAH94JgwRv9EpV_XSm6IW9TCCEUCk5eL-U',
    databaseURL: 'https://pxc-mukana.firebaseio.com',
    origin: 'https://officehours.pxclabs.com',
  },
  mimolive: { host: '127.0.0.1', port: 8989, documentId: '' },
  // [{ field, kind: 'layer'|'source', id, key }]
  targets: [],
  autoStart: false,
};

function merge(base, over) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = merge(out[k], v);
    } else if (v !== undefined) out[k] = v;
  }
  return out;
}

export function loadConfig() {
  try {
    return merge(DEFAULTS, JSON.parse(fs.readFileSync(FILE, 'utf8')));
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export function updateConfig(cfg, patch) {
  return merge(cfg, patch);
}

/** Config safe to send to the UI: never expose the refresh token. */
export function publicConfig(cfg) {
  const c = structuredClone(cfg);
  c.mukana.hasRefreshToken = !!c.mukana.refreshToken;
  delete c.mukana.refreshToken;
  return c;
}
