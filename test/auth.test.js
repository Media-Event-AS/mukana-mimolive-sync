// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 Ronny Hofsøy, Media Event AS
// UI auth: login page, cookie session, Basic fallback.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = 19790 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [path.join(here, '..', 'src', 'server.js')], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', UI_PASSWORD: 'a:b', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mms-')) },
  stdio: 'ignore',
});
try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${base}/api/status`).catch(() => null)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 401);
  assert.match(await page.text(), /Sign in/);
  assert.equal((await fetch(`${base}/api/status`)).status, 401);

  const bad = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password: 'nope' }) });
  assert.equal(bad.status, 401);

  const ok = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password: 'a:b' }) });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(`${base}/api/status`, { headers: { cookie } })).status, 200);

  const basic = 'Basic ' + Buffer.from('admin:a:b').toString('base64');
  assert.equal((await fetch(`${base}/api/status`, { headers: { authorization: basic } })).status, 200);
  console.log('✓ auth');
} finally {
  child.kill();
}
