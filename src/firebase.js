// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Ronny Hofsøy, Media Event AS
// Firebase client without SDK: token refresh via securetoken + RTDB REST streaming (SSE).
import { EventEmitter } from 'node:events';

const SECURETOKEN_URL = process.env.SECURETOKEN_URL || 'https://securetoken.googleapis.com/v1/token';

function decodeJwt(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * Keeps a valid Firebase ID token using a long-lived refresh token.
 * Emits 'token' (idToken) after every refresh and 'refreshToken' if Google rotates it.
 */
export class TokenManager extends EventEmitter {
  constructor({ apiKey, refreshToken, origin }) {
    super();
    this.apiKey = apiKey;
    this.refreshToken = refreshToken;
    this.origin = origin;
    this.idToken = null;
    this.expiresAt = 0;
    this.user = null;
    this.timer = null;
  }

  async refresh() {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (this.origin) {
      headers.Origin = this.origin;
      headers.Referer = this.origin.replace(/\/?$/, '/');
    }
    const res = await fetch(`${SECURETOKEN_URL}?key=${encodeURIComponent(this.apiKey)}`, { method: 'POST', headers, body });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.id_token) {
      const msg = json?.error?.message || `HTTP ${res.status}`;
      const err = new Error(`Token refresh failed: ${msg}`);
      err.fatal = /TOKEN_EXPIRED|INVALID_REFRESH_TOKEN|USER_DISABLED|USER_NOT_FOUND|INVALID_GRANT_TYPE|MISSING_REFRESH_TOKEN/.test(msg);
      throw err;
    }
    this.idToken = json.id_token;
    this.expiresAt = Date.now() + Number(json.expires_in || 3600) * 1000;
    const claims = decodeJwt(this.idToken);
    this.user = { uid: claims.user_id || json.user_id, email: claims.email || null, name: claims.name || null };
    if (json.refresh_token && json.refresh_token !== this.refreshToken) {
      this.refreshToken = json.refresh_token;
      this.emit('refreshToken', this.refreshToken);
    }
    this.schedule();
    this.emit('token', this.idToken);
    return this.idToken;
  }

  schedule() {
    clearTimeout(this.timer);
    const ms = Math.max(30_000, this.expiresAt - Date.now() - 5 * 60_000);
    this.timer = setTimeout(() => this.refresh().catch((e) => this.emit('error', e)), ms);
    this.timer.unref?.();
  }

  stop() {
    clearTimeout(this.timer);
  }
}

/** Apply an RTDB put/patch at `path` to a plain-object tree. Returns the new tree. */
export function applyEvent(tree, type, path, data) {
  const parts = path.split('/').filter(Boolean);
  if (type === 'put') {
    if (parts.length === 0) return data ?? null;
    const root = tree && typeof tree === 'object' ? tree : {};
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
      node = node[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (data === null) delete node[last];
    else node[last] = data;
    return root;
  }
  if (type === 'patch') {
    let root = tree && typeof tree === 'object' ? tree : {};
    for (const [k, v] of Object.entries(data || {})) {
      root = applyEvent(root, 'put', `${path}/${k}`, v);
    }
    return root;
  }
  return tree;
}

/**
 * Streams one RTDB location. Emits 'value' (full tree) on every change,
 * 'status' ('connecting'|'live'|'error'|'stopped'), 'authRevoked'.
 */
export class RtdbStream extends EventEmitter {
  constructor({ databaseURL, path, getToken }) {
    super();
    this.url = `${databaseURL.replace(/\/$/, '')}/${path.replace(/^\//, '')}.json`;
    this.path = path;
    this.getToken = getToken;
    this.tree = null;
    this.ctrl = null;
    this.running = false;
    this.backoff = 1000;
    this.status = 'stopped';
  }

  setStatus(s, detail) {
    this.status = s;
    this.emit('status', s, detail);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    this.ctrl?.abort();
    this.setStatus('stopped');
  }

  /** Reconnect (e.g. after a token refresh). */
  restart() {
    this.ctrl?.abort();
  }

  async loop() {
    while (this.running) {
      this.ctrl = new AbortController();
      try {
        this.setStatus('connecting');
        const token = await this.getToken();
        const res = await fetch(`${this.url}?auth=${encodeURIComponent(token)}`, {
          headers: { Accept: 'text/event-stream' },
          signal: this.ctrl.signal,
          redirect: 'follow',
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${text.slice(0, 120).trim()}`);
        }
        this.backoff = 1000;
        await this.consume(res.body);
        if (this.running) this.setStatus('connecting', 'stream ended');
      } catch (err) {
        if (!this.running) break;
        if (err.name !== 'AbortError') {
          this.setStatus('error', err.message);
          await new Promise((r) => setTimeout(r, this.backoff));
          this.backoff = Math.min(this.backoff * 2, 30_000);
        }
      }
    }
  }

  async consume(body) {
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        this.handle(raw);
      }
    }
  }

  handle(raw) {
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const dataStr = dataLines.join('\n');
    if (event === 'keep-alive') return;
    if (event === 'cancel') {
      this.setStatus('error', `cancelled by server (permission?) ${dataStr}`);
      return;
    }
    if (event === 'auth_revoked') {
      this.emit('authRevoked');
      this.restart();
      return;
    }
    if (event === 'put' || event === 'patch') {
      let msg;
      try {
        msg = JSON.parse(dataStr);
      } catch {
        return;
      }
      this.tree = applyEvent(this.tree, event, msg.path || '/', msg.data);
      if (this.status !== 'live') this.setStatus('live');
      this.emit('value', this.tree);
    }
  }
}
