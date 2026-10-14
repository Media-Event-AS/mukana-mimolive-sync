# Mukana → mimoLive Sync (v3)

Headless Node service that reads the live question from Mukana's Firebase Realtime Database and writes it to mimoLive layers via mimoLive's HTTP API. No Chrome, no browser extension, no DOM scraping.

```
Mukana (Firebase RTDB) ──streaming──▶ this service ──HTTP──▶ mimoLive :8989
                                          ▲
                                   web UI :8790 (LAN)
```

The full operator manual is built into the web UI (**Manual** link in the header, or `http://<host>:8790/manual.html`).

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 18.17 or newer** | Check with `node -v`. No npm packages are needed. |
| **Git** | To clone and update the repo (or download the ZIP from GitHub). |
| **Mukana account with the host role** | On the event you want to sync. Sign-in is via Google in a normal browser. |
| **mimoLive** with *Allow Remote Control Access* on | See [Configure mimoLive](#configure-mimolive). Default API port 8989. |
| **Network** | The machine running the service must reach the internet (Firebase/Google) and the mimoLive machine on the LAN (TCP 8989). Operators reach the web UI on TCP 8790. |

The service can run on the mimoLive machine itself or on any other machine (Mac, Linux, Windows) on the same LAN.

## Install

```bash
# 1. Node.js (macOS, Homebrew) – or install the LTS package from https://nodejs.org
brew install node

# 2. Get the code
git clone https://github.com/Media-Event-AS/mukana-mimolive-sync.git
cd mukana-mimolive-sync

# 3. (Optional) run the test suite
npm test
```

There is no `npm install` step: the service has zero dependencies.

**Update** to the latest version: `git pull` in the repo folder, then restart the service.

## Run

```bash
cd mukana-mimolive-sync
npm start
```

Open `http://localhost:8790` on the same machine, or `http://<machine-ip>:8790` from another machine on the LAN. Stop with **Ctrl+C**.

| Env variable | Default | Purpose |
|---|---|---|
| `PORT` | `8790` | Web UI port. Overrides (and locks) the setting in the web UI. |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` = this machine only). Overrides (and locks) the setting in the web UI. |
| `UI_PASSWORD` | – | Optional password for the web UI. Off by default. |
| `DATA_DIR` | `data` | Where `config.json` is stored (includes the refresh token, file mode 600) |
| `TZ` | system | Time zone for the HH:MM fields, e.g. `Europe/Oslo` |

Example: `PORT=9000 TZ=Europe/Oslo npm start`

The listen address and port can also be changed in the web UI under **5 · Service**. The change takes effect immediately and is remembered.

If sync was running when the service stopped, it starts again automatically on the next launch.

### Run in the background on macOS (launchd)

Easiest: in the web UI, section **5 · Service**, click **Start at login** (or **Start at login + move to background now**). This installs a per-user launchd agent with the current port, time zone and UI password. The log is in `~/Library/Logs/mukana-mimolive-sync.log`. If you move the folder or upgrade Node, turn it off and on again.

Manual alternative:


Replace `/path/to/mukana-mimolive-sync` with your folder and check the node path (`which node`) in `launchd/no.mediaevent.mukana-sync.plist`, then:

```bash
cp launchd/no.mediaevent.mukana-sync.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/no.mediaevent.mukana-sync.plist
# stop / remove
launchctl unload ~/Library/LaunchAgents/no.mediaevent.mukana-sync.plist
```

Log file: `/tmp/mukana-sync.log`.

## Configure mimoLive

Do this once on the mimoLive machine:

1. **mimoLive → Settings…** (*Preferences…* in older versions) → **Remote Control** tab.
2. Turn on **Allow Remote Control Access**.
3. Optional: set a password. If you do, enter the same password in the web UI's mimoLive section. The service sends it as the `X-MimoLive-Password-SHA256` header.
4. Keep the show document open. The API only lists open documents.

If the service runs on another machine, allow incoming connections for mimoLive in the macOS firewall (System Settings → Network → Firewall → Options). Test with `http://<mimolive-ip>:8989/api/v1/documents`, which should return JSON.

Some mimoLive versions reportedly re-add a one-character password on their own after a restart. If the UI shows *password required*, clear or enter the password. Never expose port 8989 to the internet.

Sources: [mimoLive Remote Control](https://mimolive.com/user-manual/remote-control-automation/remote-control-surfaces.md), [mimoLive HTTP API](https://mimolive.com/user-manual/remote-control-automation/http-api.md), [Boinx forum: password bug](https://forum.boinx.com/t/remote-control-adds-a-single-character-password-by-itself/18131).

## First-time setup (web UI)

1. **Mukana** – enter the Event ID (e.g. `ohtest`) and a refresh token. To get the token: sign in to Mukana panelView in Chrome or Safari, open the DevTools console and run
   `copy(firebase.auth().currentUser.refreshToken)`. The console prints `undefined`; the token is on the clipboard. Paste it and **Save**.
2. **mimoLive** – **Scan network** (finds mimoLive on port 8989 on the local /24 subnets) or type the IP, enter the password if mimoLive uses one, **Load documents**, pick the document, **Save**.
3. **Mapping** – one row per output: Mukana field → mimoLive layer/source → input key. **Save mapping**.
4. **Start sync**. Check the *Live* panel, and use **Verify against mimoLive** to read the values back from mimoLive.

## Fields

| Group | Field | Mukana source |
|---|---|---|
| Question | Name, Question (URL removed / original), Location, Tag, Votes | `qs_liveQ/{event}` (`n`, `q`, `l`, `tag`, `v`; votes are stored negated and shown positive) |
| | Country code / flag emoji | `loc_cc` |
| | URL in question (QR) | First URL found in `q` |
| | Host notes | `comments_host_output/{event}/{key}/hostNotes` |
| | Source (raw / label) | `…/source`: `mukana`/`lite` Mobile, `full` Web, `form` QR form, `panel` Panel, `chat`, `facebook`, `youtube`, `twitter` |
| | Name / location phonetics | `…/namePho`, `…/locPho` |
| | Asked at, Answering since | `…/ts_created`, `…/ts_answered` (HH:MM) |
| | Done reading | `qs_liveQ/{event}/rd` |
| Panel | Panelist queue, Active panelist | `panel_hands/{event}/{key}/array[]` (`st` = q/a/c) |
| | Panelists online | `panel_onlinelist/{event}` |
| Next Up | Name, location, tag, question (URL removed / original) | First non-live item in `comments_host_output/{event}`, sorted by `orderID` |
| Counts | Voting Qs, On Deck, Answered | Number of items in `comments_source`, `comments_host_output`, `comments_answered` (same as the panelView tabs) |

When no question is live, Question and Panel fields are cleared; Next Up and Counts stay updated. Only changed values are sent to mimoLive.

## How it connects (and what it costs)

Nothing is polled.

| Link | Mechanism | Traffic |
|---|---|---|
| Mukana → service | 6 Firebase RTDB REST streams (Server-Sent Events) on `qs_liveQ`, `panel_hands`, `panel_onlinelist`, `comments_host_output`, `comments_source`, `comments_answered`. One full snapshot on connect, then only changes are pushed. | Keep-alive about every 30 s. Silence when nothing changes. |
| Auth | Firebase refresh token → ID token via `securetoken.googleapis.com` once per hour. Streams reconnect and re-download their snapshot. | A few hundred KB per hour at most, even with hundreds of questions. |
| Service → mimoLive | HTTP GET with `?update=` to the mimoLive API, only when a mapped value changes. | LAN only. |
| Web UI → service | Status poll every second while the UI is open. | LAN only. |

Firebase bills for downloaded data and concurrent connections, and the Firebase project (`pxc-mukana`) belongs to Mukana, not to us. The load is about the same as one extra panelist with panelView open, and lower in practice, since panelView also streams chat, likes and DMs. Only `comments_source` and `comments_answered` grow with the number of questions. If an event ever has thousands of questions, those two can be switched to periodic count-only (`?shallow=true`) requests.

## Upgrading from v2 (Chrome extension)

v3 replaces the Chrome extension entirely. Remove the old extension in `chrome://extensions`. The layer IDs from the v2 config panel still work: pick the same layers in the v3 mapping.

The v2 extension code (last version 2.0.8) is kept on the [`legacy-v2-extension`](https://github.com/Media-Event-AS/mukana-mimolive-sync/tree/legacy-v2-extension) branch.

## About & support

| | |
|---|---|
| Developer | Ronny Hofsøy |
| Company | [Media Event AS](https://www.mediaevent.no), Tromsø, Norway |
| Contact | ronny@mediaevent.no |
| Issues | [GitHub Issues](https://github.com/Media-Event-AS/mukana-mimolive-sync/issues) |

Mukana and mimoLive are products of their respective owners. This tool is independent and not affiliated with or endorsed by them.

## License

Copyright © 2026 Ronny Hofsøy, Media Event AS.

This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License version 3, as published by the Free Software Foundation. It is distributed WITHOUT ANY WARRANTY. See [LICENSE](LICENSE) for the full text.

## Test

`npm test` – unit tests, end-to-end against mock Firebase and mock mimoLive, and UI auth.

## Limitations

- Mukana's data structure is undocumented (mapped from panelView v260113a). If Mukana changes its paths, update `src/sync.js`.
- Firebase settings (API key, database URL, origin) can be changed under *Advanced* in the web UI for another Mukana instance.
- The refresh token is tied to your Google sign-in. Signing out everywhere or revoking access means pasting a new token.
