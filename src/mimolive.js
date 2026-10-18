// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Ronny Hofsøy, Media Event AS
// mimoLive HTTP API client (JSON:API, default port 8989) + LAN discovery.
// Optional password: mimoLive expects the SHA-256 hex of the password in X-MimoLive-Password-SHA256.
import os from 'node:os';
import crypto from 'node:crypto';

export class MimoLiveAuthError extends Error {}

async function request(url, { headers = {}, timeoutMs = 4000 } = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 401 || res.status === 403) {
    throw new MimoLiveAuthError(`mimoLive requires a password (HTTP ${res.status}). Set it in the mimoLive section, or turn off authentication in mimoLive.`);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${t.slice(0, 120)}`);
  }
  return res;
}

export class MimoLive {
  constructor({ host, port, password }) {
    this.base = `http://${host}:${port}/api/v1`;
    this.headers = password ? { 'X-MimoLive-Password-SHA256': crypto.createHash('sha256').update(password).digest('hex') } : {};
  }

  async getJson(path) {
    return (await request(`${this.base}${path}`, { headers: this.headers })).json();
  }

  async documents() {
    const j = await this.getJson('/documents');
    return (j.data || []).map((d) => ({ id: String(d.id), name: d.attributes?.name || String(d.id) }));
  }

  async layers(docId) {
    const j = await this.getJson(`/documents/${docId}/layers`);
    return (j.data || []).map((l) => ({
      id: l.id,
      name: l.attributes?.name || l.id,
      kind: 'layer',
      inputKeys: Object.keys(l.attributes?.['input-values'] || {}),
    }));
  }

  async sources(docId) {
    const j = await this.getJson(`/documents/${docId}/sources`);
    return (j.data || []).map((s) => ({
      id: s.id,
      name: s.attributes?.name || s.id,
      type: s.attributes?.['source-type'] || '',
      kind: 'source',
      inputKeys: Object.keys(s.attributes?.['input-values'] || {}),
    }));
  }

  /** Read current input values of a layer or source. */
  async getInputs({ documentId, kind, id }) {
    const coll = kind === 'source' ? 'sources' : 'layers';
    const j = await this.getJson(`/documents/${documentId}/${coll}/${id}`);
    return { name: j.data?.attributes?.name || id, values: j.data?.attributes?.['input-values'] || {} };
  }

  /** Set one input value on a layer or source. Uses the ?update= form proven in the v2 extension. */
  async setInput({ documentId, kind, id, key, value }) {
    const coll = kind === 'source' ? 'sources' : 'layers';
    const update = encodeURIComponent(JSON.stringify({ 'input-values': { [key]: value ?? '' } }));
    await request(`${this.base}/documents/${documentId}/${coll}/${id}?update=${update}`, { headers: this.headers });
  }

  /** Take a layer live with its selected variant. Safe to call on a live layer. */
  async setLive(documentId, layerId) {
    await request(`${this.base}/documents/${documentId}/layers/${layerId}/setLive`, { headers: this.headers });
  }

  /** Switch a layer off. It may stay in "shutdown" while its out-transition plays. */
  async setOff(documentId, layerId) {
    await request(`${this.base}/documents/${documentId}/layers/${layerId}/setOff`, { headers: this.headers });
  }

  /** Variants of a layer, e.g. one per person in a Lower Third layer. */
  async variants(docId, layerId) {
    const j = await this.getJson(`/documents/${docId}/layers/${layerId}/variants`);
    return (j.data || []).map((v) => ({ id: v.id, name: v.attributes?.name || v.id }));
  }

  /** Take one variant live; mimoLive takes its layer live too. */
  async setVariantLive(documentId, layerId, variantId) {
    await request(`${this.base}/documents/${documentId}/layers/${layerId}/variants/${variantId}/setLive`, { headers: this.headers });
  }

  /** "off" | "live" | "preview" | "shutdown" */
  async layerState(documentId, layerId) {
    const j = await this.getJson(`/documents/${documentId}/layers/${layerId}`);
    return j.data?.attributes?.['live-state'] || 'off';
  }

  /** Layer sets (mimoLive 5.0+). Older versions answer 404, which is returned as an empty list. */
  async layerSets(docId) {
    const j = await this.getJson(`/documents/${docId}/layer-sets`).catch(() => ({ data: [] }));
    return (j.data || []).map((s) => ({
      id: s.id,
      name: s.attributes?.name || s.id,
      // Older mimoLive versions do not list the layer actions.
      layers: (s.attributes?.layers || []).map((l) => ({ id: l['layer-id'], action: l.action })),
    }));
  }

  /** Trigger a signal input (key ending in _TypeSignal) of a layer. */
  async signal(documentId, layerId, signalId) {
    await request(`${this.base}/documents/${documentId}/layers/${layerId}/signals/${signalId}`, { headers: this.headers });
  }

  async recallLayerSet(documentId, setId) {
    await request(`${this.base}/documents/${documentId}/layer-sets/${setId}/recall`, { headers: this.headers });
  }
}

/** Scan local /24 subnets for mimoLive on `port`. Returns [{host, port, documents, needsPassword}]. */
export async function discover(port = 8989, { timeoutMs = 600, concurrency = 64, password } = {}) {
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
      const ml = new MimoLive({ host, port, password });
      try {
        const res = await request(`${ml.base}/documents`, { headers: ml.headers, timeoutMs });
        const j = await res.json();
        found.push({ host, port, needsPassword: false, documents: (j.data || []).map((d) => ({ id: String(d.id), name: d.attributes?.name || String(d.id) })) });
      } catch (e) {
        if (e instanceof MimoLiveAuthError) found.push({ host, port, needsPassword: true, documents: [] });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return found.sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true }));
}
