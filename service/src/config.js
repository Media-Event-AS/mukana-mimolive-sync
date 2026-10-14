// Persistent configuration (data/config.json). Written atomically.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const FILE = path.join(DATA_DIR, 'config.json');

const TXT = 'tvGroup_Content__Text_TypeMultiline';
export const FIELDS = [
  // Current question
  { id: 'name', label: 'Name', group: 'Question', defaultKey: TXT },
  { id: 'question', label: 'Question (URL removed)', group: 'Question', defaultKey: TXT },
  { id: 'questionFull', label: 'Question (original)', group: 'Question', defaultKey: TXT },
  { id: 'location', label: 'Location', group: 'Question', defaultKey: TXT },
  { id: 'countryCode', label: 'Country code', group: 'Question', defaultKey: TXT },
  { id: 'countryFlag', label: 'Country flag (emoji)', group: 'Question', defaultKey: TXT },
  { id: 'tag', label: 'Tag', group: 'Question', defaultKey: TXT },
  { id: 'votes', label: 'Votes', group: 'Question', defaultKey: TXT },
  { id: 'url', label: 'URL in question (QR)', group: 'Question', defaultKey: 'tvGroup_Content__QR_Content' },
  { id: 'notes', label: 'Host notes', group: 'Question', defaultKey: 'tvGroup_Note__Note_TypeMultiline' },
  { id: 'source', label: 'Source (raw key)', group: 'Question', defaultKey: TXT },
  { id: 'sourceLabel', label: 'Source (label)', group: 'Question', defaultKey: TXT },
  { id: 'namePhonetic', label: 'Name phonetics', group: 'Question', defaultKey: TXT },
  { id: 'locationPhonetic', label: 'Location phonetics', group: 'Question', defaultKey: TXT },
  { id: 'askedAt', label: 'Asked at (HH:MM)', group: 'Question', defaultKey: TXT },
  { id: 'answeringSince', label: 'Answering since (HH:MM)', group: 'Question', defaultKey: TXT },
  { id: 'doneReading', label: 'Done reading (“yes” / empty)', group: 'Question', defaultKey: TXT },
  // Panel
  { id: 'queue', label: 'Panelist queue (queued)', group: 'Panel', defaultKey: 'tvGroup_Note__Note_TypeMultiline' },
  { id: 'activePanelist', label: 'Active panelist', group: 'Panel', defaultKey: TXT },
  { id: 'panelistsOnline', label: 'Panelists online (count)', group: 'Panel', defaultKey: TXT },
  // Rundown
  { id: 'waitingCount', label: 'Questions waiting (count)', group: 'Rundown', defaultKey: TXT },
  { id: 'nextName', label: 'On deck: name', group: 'Rundown', defaultKey: TXT },
  { id: 'nextQuestion', label: 'On deck: question', group: 'Rundown', defaultKey: TXT },
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
