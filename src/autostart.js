// macOS autostart via a per-user launchd agent (~/Library/LaunchAgents).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LABEL = 'no.mediaevent.mukana-sync';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'server.js');
const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const logPath = () => path.join(os.homedir(), 'Library', 'Logs', 'mukana-mimolive-sync.log');

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** Build the plist. Pure, so it can be tested on any OS. */
export function buildPlist({ node = process.execPath, server = SERVER, cwd = ROOT, env = {}, log = logPath() } = {}) {
  const envXml = Object.entries({ ...env, MMS_LAUNCHD: '1' })
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(server)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

function loaded() {
  try {
    execFileSync('launchctl', ['list', LABEL], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function status() {
  const supported = process.platform === 'darwin';
  return {
    supported,
    platform: process.platform,
    installed: supported && fs.existsSync(plistPath()),
    loaded: supported && loaded(),
    runningUnderLaunchd: process.env.MMS_LAUNCHD === '1',
    plistPath: supported ? plistPath() : null,
    logPath: supported ? logPath() : null,
  };
}

/** Write the agent so the service starts at login. Captures the current env settings. */
export function enable() {
  if (process.platform !== 'darwin') throw new Error('Autostart from the UI is only available on macOS.');
  const env = {};
  for (const k of ['PORT', 'HOST', 'UI_PASSWORD', 'TZ']) if (process.env[k]) env[k] = process.env[k];
  env.DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.mkdirSync(path.dirname(logPath()), { recursive: true });
  fs.writeFileSync(plistPath(), buildPlist({ env }), { mode: 0o600 }); // may contain UI_PASSWORD
  return status();
}

/**
 * Hand over to launchd right now: this process exits and launchd starts the service in the background.
 * Called after the HTTP response is sent.
 */
export function handoverToLaunchd(closeServer) {
  const child = spawn('/bin/sh', ['-c', `sleep 1; launchctl load -w "${plistPath()}"`], { detached: true, stdio: 'ignore' });
  child.unref();
  closeServer(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

/** Remove the agent. If we are running under launchd, this stops the service. */
export function disable() {
  if (process.platform !== 'darwin') throw new Error('Autostart from the UI is only available on macOS.');
  const p = plistPath();
  const wasLaunchd = process.env.MMS_LAUNCHD === '1';
  const remove = () => {
    try {
      fs.unlinkSync(p);
    } catch {}
  };
  if (wasLaunchd) {
    // Unloading kills us, so delete the file first and unload from a detached shell.
    remove();
    spawn('/bin/sh', ['-c', `sleep 1; launchctl remove ${LABEL}`], { detached: true, stdio: 'ignore' }).unref();
  } else {
    try {
      execFileSync('launchctl', ['unload', '-w', p], { stdio: 'ignore' });
    } catch {}
    remove();
  }
  return { ...status(), installed: false, stopping: wasLaunchd };
}
