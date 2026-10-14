// mimoLive HTTP API client (JSON:API, default port 8989) + LAN discovery.
import os from 'node:os';

async function getJson(url, timeoutMs = 4000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export class MimoLive {
  constructor({ host, port }) {
    this.base = `http://${host}:${port}/api/v1`;
  }

  async documents() {
    const j = await getJson(`${this.base}/documents`);
    return (j.data || []).map((d) => ({ id: String(d.id), name: d.attributes?.name || String(d.id) }));
  }

  async layers(docId) {
    const j = await getJson(`${this.base}/documents/${docId}/layers`);
    return (j.data || []).map((l) => ({
      id: l.id,
      name: l.attributes?.name || l.id,
      kind: 'layer',
      inputKeys: Object.keys(l.attributes?.['input-values'] || {}),
    }));
  }

  async sources(docId) {
    const j = await getJson(`${this.base}/documents/${docId}/sources`);
    return (j.data || []).map((s) => ({
      id: s.id,
      name: s.attributes?.name || s.id,
      kind: 'source',
      inputKeys: Object.keys(s.attributes?.['input-values'] || {}),
    }));
  }

  /** Set one input value on a layer or source. Uses the ?update= form proven in the v2 extension. */
  async setInput({ documentId, kind, id, key, value }) {
    const coll = kind === 'source' ? 'sources' : 'layers';
    const update = encodeURIComponent(JSON.stringify({ 'input-values': { [key]: value ?? '' } }));
    const url = `${this.base}/documents/${documentId}/${coll}/${id}?update=${update}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${t.slice(0, 120)}`);
    }
  }
}

/** Scan local /24 subnets for mimoLive on `port`. Returns [{host, port, documents:[...]}]. */
export async function discover(port = 8989, { timeoutMs = 600, concurrency = 64 } = {}) {
  const hosts = new Set(['127.0.0.1']);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x, y, z] = a.address.split('.');
      for (let i = 1; i < 255; i++) hosts.add(`${x}.${y}.${z}.${i}`);
    }
  }
  const list = [...hosts];
  const found = [];
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const host = list[next++];
      try {
        const j = await getJson(`http://${host}:${port}/api/v1/documents`, timeoutMs);
        found.push({
          host,
          port,
          documents: (j.data || []).map((d) => ({ id: String(d.id), name: d.attributes?.name || String(d.id) })),
        });
      } catch {
        /* not mimoLive */
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  // Collapse localhost duplicate of own LAN IP
  return found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}
