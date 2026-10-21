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
| **Node.js 18.17 or newer** | Check with `node -v`. No npm packages are needed. On macOS, the installer sets it up for you. |
| **Git** | Only for the manual install. The macOS installer does not need it. |
| **Mukana account with the host role** | On the event you want to sync. Sign-in is via Google in a normal browser. |
| **mimoLive** with *Allow Remote Control Access* on | See [Configure mimoLive](#configure-mimolive). Default API port 8989. |
| **Network** | The machine running the service must reach the internet (Firebase/Google) and the mimoLive machine on the LAN (TCP 8989). Operators reach the web UI on TCP 8790. |

The service can run on the mimoLive machine itself or on any other machine (Mac, Linux, Windows) on the same LAN.

## Install

### macOS: one command (recommended)

Works on a fresh Mac. You do **not** need Homebrew, Node.js or Git first.

1. Open **Terminal** (press **⌘ Space**, type *Terminal*, press Return).
2. Paste this line and press Return:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/Media-Event-AS/mukana-mimolive-sync/main/install-mac.sh | bash
   ```

3. If Node.js is missing, the installer downloads the official LTS `.pkg` from nodejs.org, checks its SHA-256 checksum and asks for **your Mac login password** to install it. Nothing shows while you type the password.
4. Wait for **Done!**. Every step should show a green ✔. Answer **Y** to start the service now.

What [`install-mac.sh`](install-mac.sh) does:

| Step | |
|---|---|
| 1. Node.js | Uses Node 18.17+ if it is already installed (also finds it in `/opt/homebrew/bin` and `/usr/local/bin`). Otherwise installs Node.js LTS from nodejs.org into `/usr/local/bin`. |
| 2. PATH | Opens a new login shell to check that `node` and `npm` are found. If not, it adds the folder to `~/.zprofile` (or `~/.bash_profile`) and checks again. |
| 3. App | Downloads the latest version to `~/mukana-mimolive-sync`. If that folder is a Git checkout, it runs `git pull` instead. Settings in `data/` are kept. Run from inside a copy of the repo (`bash install-mac.sh`), it uses that copy. `MUKANA_DIR=/other/folder` changes the folder. |
| 4. Verify | Prints the node and npm versions and checks the app files. |

**Update** to the latest version: run the same command again, then restart the service.

If you see a red ✘, copy the whole Terminal window and send it to ronny@mediaevent.no.

### Manual install (any OS)

```bash
# 1. Node.js 18.17 or newer: install the LTS package from https://nodejs.org
node -v

# 2. Get the code
git clone https://github.com/Media-Event-AS/mukana-mimolive-sync.git
cd mukana-mimolive-sync

# 3. (Optional) run the test suite
npm test
```

There is no `npm install` step: the service has zero dependencies.

**Update** to the latest version: `git pull` in the repo folder, then restart the service.

### Troubleshooting: `command not found`

| Message | Fix |
|---|---|
| `command not found: brew` | You do not need Homebrew. Use the one-command installer above. |
| `command not found: npm` or `node` | Run the installer. It installs Node.js and fixes the PATH. Then open a **new** Terminal window. |
| `Missing script: "start"` | You are in the wrong folder. Run `cd ~/mukana-mimolive-sync` first. |

## Run

On a Mac, double-click **`start-mac.command`** in the `mukana-mimolive-sync` folder. A Terminal window opens and runs the service, and the web UI opens in your browser. Or, in Terminal:

```bash
cd ~/mukana-mimolive-sync
npm start
```

Open `http://localhost:8790` on the same machine, or `http://<machine-ip>:8790` from another machine on the LAN. Stop with **Ctrl+C**.

Three **status lights** in the header show the connections: **Server** (the page reaches the service), **Mukana** (green = all streams live, yellow = connecting or simulating, red = error, grey = sync stopped) and **mimoLive** (green = reachable with the show document open, yellow = document not open, red = not reachable, or a mimoLive password is missing or wrong; checked every 5 s, also when sync is stopped). Hover a light for the reason.

| Env variable | Default | Purpose |
|---|---|---|
| `PORT` | `8790` | Web UI port. Overrides (and locks) the setting in the web UI. |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` = this machine only). Overrides (and locks) the setting in the web UI. |
| `UI_PASSWORD` | – | Optional password for the web UI. Off by default. |
| `DATA_DIR` | `data` | Where `config.json` is stored (includes the refresh token, file mode 600) |
| `TZ` | system | Time zone for the HH:MM fields, e.g. `Europe/Oslo` |

Example: `PORT=9000 TZ=Europe/Oslo npm start`

**Development:** `npm run dev` runs the service in watch mode. It restarts by itself when a file in `src/` changes. Changes in `public/` need only a page reload. If sync was running, it reconnects after each restart.

The listen address and port can also be changed in the web UI under **7 · Service**. The change takes effect immediately and is remembered.

If sync was running when the service stopped, it starts again automatically on the next launch.

### Run in the background on macOS (launchd)

Easiest: in the web UI, section **7 · Service**, click **Start at login** (or **Start at login + move to background now**). This installs a per-user launchd agent with the current port, time zone and UI password. The log is in `~/Library/Logs/mukana-mimolive-sync.log`. If you move the folder or upgrade Node, turn it off and on again.

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
4. **Layer control** (optional) – a cue list that takes layers and layer sets live and off on Mukana events, timers or Companion buttons. See [Layer control](#layer-control-cue-list).
5. **Panelists** (optional) – sources, layouts and lower thirds for panelists. See [Panelists](#panelists).
6. **Start sync**. Check the *Live* panel, and use **Verify against mimoLive** to read the values back from mimoLive.

## Show profiles

The **Show profile** bar at the top of the web UI switches between shows.

| In a profile | Stays on this machine |
|---|---|
| Mukana **Event ID** and **login token** (🔑) | mimoLive password |
| mimoLive host, port and **document** | Firebase advanced settings |
| Mapping, **cue list**, **Panelists** (people, layouts, lower third, pre-flight list) | Web UI address and port, start at login |

| Button | Does |
|---|---|
| **Load** | Switches to the selected show (two clicks). The token in the profile is used, so there is no need to make a new one; a profile without a token keeps the current login. Mukana reconnects if the event or login changed. |
| **Save** / **Save as…** | Saves the current show over its profile, or under a new name. The bar shows *saved* / *unsaved changes*. |
| **New show** | Empties Event ID, document, mapping, cue list and panelists (two clicks). The login token and the mimoLive machine are kept. |
| **Download** / **Upload** | A profile as a `.json` file, e.g. to move a show to another machine. The download leaves the login token out unless **incl. login token** is ticked; only tick it for your own machines, since anyone with the file can sign in to Mukana as you. |
| **Delete** | Removes the selected profile from this machine (two clicks). |

After **Load** and **New show**, **Auto layers** is off, so a show never fires cues by itself before you are ready. Profiles are stored in `data/profiles/` (not in git), readable by your user only.

## Layer control (cue list)

Section **4 · Layer control** is a cue list that works like QLab. Each row is a cue:

| Column | Meaning |
|---|---|
| **Trigger** | What fires the cue: a **Mukana event** (only while **Auto layers** is on), **GO / Companion** (manual), or **—** (only reached from the cue above). Every cue can also be fired with its **GO** button. |
| **Pre-wait** | Seconds between firing and doing the action. |
| **Action** | **Recall layer set** · **Layers live** / **Layers off** (one or more layers; off is done when they are fully off) · **Switch off a set's layers** · **Panelist layout** · **Panelist lower third** · **Source into slot** · **Role into slot** (see [Panelists](#panelists)) · **Write text** (into a layer or source input; `{name}`, `{location}`… are replaced by the live question's fields) · **Trigger signal** · **Wait** N s, or **pause until** GO / Continue or a Mukana event (the seconds are then an optional timeout) · **Fire cue** |
| **Continue** | **—** stops here · **Auto-continue** starts the next cue at the same moment as this one, so the pre-waits of a run of auto-continued cues read like a timeline (0 s, 3 s, 6 s…) · **Auto-follow** starts the next cue when this one's action is done |
| **Cancels** | Cue numbers to stop when this cue fires, e.g. `2, 3` |

A paused cue shows **⏸ paused** and its **GO** button becomes **Continue**: GO on a paused cue continues it instead of restarting it. A cue paused until a Mukana event continues when that event happens. A cue fired again while running restarts and stops everything it started. **Stop all cues** stops everything (no confirm, it is the panic button). Turning **Auto layers** off also stops all running cues; GO still works.

**Mukana events:** question goes live · next question replaces the live one (also counts as "goes live") · question done or cancelled · host marks done reading · panelist raises hand (below the line) · panelist moved above the line · panelist starts answering · panelists answering change (join, leave, switch) · last panelist stops answering (also when the question ends while panelists answer) · host notes added or changed. Hand and notes events only count within the same question: a question that goes live with hands already up fires only "goes live". The host never counts as answering.

**Question text timing is built in.** When the live question changes, question text in layers a cue has taken live is held at what is on screen. A cue that takes such a layer live first takes it off (out-animation), then writes the new text; a cue that takes it off clears the text once it is off. Layers no cue has taken live update at once.

Example (what the old "auto-off" rule becomes):

| # | Name | Trigger | Pre-wait | Action | Continue | Cancels |
|---|---|---|---|---|---|---|
| 1 | Question on | Question goes live | 0 | Recall "2UP w/question" | Auto-follow | |
| 2 | Back to host | — | 12 | Recall "Fullscreen 1" | — | |
| 3 | Question done | Question done or cancelled | 0 | Recall "Fullscreen 1" | — | 1, 2 |

Rules saved by earlier versions are converted to cues like these on start.

### Simulate

The buttons under **Simulate Mukana** act as if the event happened in Mukana: cues fire, question text and panelists follow, and **mimoLive is driven for real**. The first click switches the input from Mukana to a sample question; Mukana is ignored until **End simulation**. Pick a person from the People table for the hand events, or use the sample panelist.

### Companion / HTTP API

For a Stream Deck via Bitfocus Companion (or curl). With `UI_PASSWORD` set, use Basic auth.

| Request | Does |
|---|---|
| `GET /api/cues` | State for button feedback: `autoLayers`, `simulating`, `questionLive`, `question`, `answering` (names), and per cue `number`, `name`, `running`, `phase` (`waiting`/`paused`/`acting`/`idle`), `endsAt`, `until` (what a paused cue waits for), plus `shot` (on screen now) and `answerShot` (the current shot for answering) |
| `POST /api/cues/<number or id>/go` | Fire a cue |
| `POST /api/cues/<number or id>/continue` | Continue a paused cue (GO on a paused cue does the same) |
| `POST /api/shot/<host, solo or hostOnly>` | Change shot right away (with host / answering only / host only) |
| `POST /api/cues/<number or id>/stop` | Stop a cue and what it started |
| `POST /api/cues/stop-all` | Stop every cue |
| `POST /api/auto-layers` | Toggle Auto layers; body `{"enabled": true}` / `false` to set it |
| `POST /api/simulate/<event>` | Simulate a Mukana event (`questionLive`, `questionNext`, `questionDone`, `doneReading`, `handRaised`, `aboveLine`, `answeringStart`, `answeringEnd`, `hostNotes`; "answering change" follows from start/stop); body `{"uid": "…"}` picks the panelist |
| `POST /api/cues/add-panelist-cues` | Add the panelist cues (see [Panelists](#panelists)) |
| `POST /api/simulate/end` | Back to Mukana |

## Panelists

**5 · Panelists** holds who is who, their video sources and lower thirds, and which layout to use for how many are answering. Nothing in it runs by itself: the cue list decides when, with these actions:

| Cue action | What it does |
|---|---|
| **Panel layout (above the line)** | The panel for this question: everyone the host has approved **above the line** (and anyone answering), in queue order. Picks the layout row for that many, puts their video sources into the slots (B, C, D…; the host stays in A) and recalls the row's layer set. Use it when the host presents the panel before going to each of them. Raised hands below the line are not shown. |
| **Answering layout (who answers now)** | The same, but only who is **answering** right now (normally one), in a **shot**: *With host*, *Answering only*, or *Current shot* (the last one chosen; back to *with host* on each new question). When one leaves, the others shift up. Nobody answering: nothing changes. Going from the panel shot to this one always counts as a new shot. If the lower third shows someone who is no longer alone on screen, it goes out first. |
| **Panelist lower third** | With exactly one panelist who just started (not after shrinking from several): their name and title (or their variant) into the lower third, then live. |
| **Change shot** | *With host*, *Answering only* or *Host only*, right away, for whoever is answering. With host and answering only become the current shot; **host only is momentary**: the next panelist comes back in the last shot. Make three GO cues for these and put them on Stream Deck buttons. |
| **Role into slot** | The person with a role (Reader or Host) into a slot of a layer, e.g. the reader into B while the question is read. |
| **Source into slot** | A fixed source into a slot. |

Both layout actions place whoever qualifies **when the cue runs**; they do not wait. A typical flow: question goes live → host, reader and question → **Panel layout** → **Wait until GO / Continue** (or until *Panelist starts answering*) → the host clicks the first panelist in Mukana, which fires **Answering layout** → lower third → next panelist…

**Roles:** the **host** never counts and is never placed by the layout actions. The **reader** is placed by *Role into slot* while the question is read, and counts as a panelist only while above the line or answering on that question (on the next question they are just the reader again). **Panelists** fill the slots when they answer.

**Add panelist cues to the cue list** (button in 5 · Panelists) adds a working set, and configs that used the older automatic panelists get them once on start:

| Cue | Trigger | Action |
|---|---|---|
| Reader into B | Question goes live | Role into slot: reader → B of the 1-panelist layout layer, then auto-follow into your "question goes live" cue |
| Question overlay off | Panelist starts answering | Layers off: the layers your question set takes live that the layout and done sets do not (e.g. Q Title, Q Name, Q Text, Q Location, Q BG) |
| Answering · with host | Panelists answering change | Answering layout, with host; cancels the question flow; auto-continue → (timeline starts) |
| Panelist name | — (at *Show after*, e.g. 3 s) | Panelist lower third; auto-continue → |
| Go single | — (at 6 s; only with an *answering only* row) | Change shot → answering only; auto-continue → |
| Panelist name off | — (at *Show after* + *Off after*, e.g. 11 s) | Layers off: the lower third |
| Panelists done | Last panelist stops answering | Layers off: the lower third; cancels the timeline |
| Shot: with host / answering only / host only | GO / Companion | Change shot (one cue per shot you have rows for) |

Every new panelist the host clicks fires *Answering · with host* again, which restarts the whole timeline for them: with host, name, single, name off.

| In Mukana | On air (with those cues) |
|---|---|
| Nobody → 1 answering | Question overlay off; source into B, recall the 1-panelist layout; lower third after the delay. |
| A question goes live with a panelist already answering | Only the question cues run. Panelist cues start when someone is made answering while the question is live. |
| Panelist 1 → panelist 2 (still one) | Lower third out (waits for its out-animation), B cuts to panelist 2, panelist 2's lower third after the delay. The layout stays. |
| A second panelist joins | Sources into B and C, recall the 2-panelist layout. Lower third out: none with several. |
| A panelist leaves while others stay | The rest shift up (C → B), the smaller layout is recalled. No new lower third. |
| Nobody answering any more / question ends | The layout stays; the lower third goes off. |

Set it up in **5 · Panelists**:

- **Lower third**: the layer (a layer named "Lower Third" is suggested), *Show after* and *Off after* in seconds, and how: **Write name + title into it** (default) writes the person's name and title into the layer's text inputs (*Name goes into* / *Title goes into*, default `tvGroup_Content__Title` / `tvGroup_Content__Subtitle`) while it is off, then takes it live. **One variant per person** takes the person's own variant of the layer live instead.
- **People**: Mukana person → role → video source → *Name on screen* (empty = their Mukana name) and *Title*, or their variant in variant mode. In *write name + title* mode, people added from Mukana get their Mukana location as the title to start with; change it to a job title if you prefer. The role is **Panelist**, **Host** or **Reader** (see Roles above). You pick from everyone who **raised a hand on the pre-flight question** (a question whose text contains *Pre-flight checklist*). Mukana drops the hands once that question is answered, so the service captures them while it is live or on deck (sync must be running) and keeps the list in its config, per event. Until anyone has raised a hand, you pick from the panelists **online now** (hosts excluded). **Add all from pre-flight** adds everyone on the list. For people who arrive after the pre-flight question is done, **Add all from current question** adds everyone with a raised hand on the question that is live now (and puts them on the list). **Clear pre-flight list** starts over. The variant is suggested when its name starts with the panelist's name (e.g. "Kjersti Monsen – Daglig Leder"). Panelists are matched by their Mukana ID, so a changed display name still matches. Video sources are grouped by type: Zoom, Camera inputs and NDI first, then the rest.
- **Layouts**: how many → **shot** → layer set to recall → the layer that holds the slots (suggested from the set's name) → slots. Shots: **With host** (host in A, people from B), **Answering only** (people from A, e.g. 1 → "Fullscreen 2", layer "Full Screen", slot A), and one **Host only** row (how many = 0, just the set to recall). With more people than the largest layout of a shot, the largest is used; with no *answering only* row for that many, *with host* is used.

Other automations that write into the same lower third (for example a mimoLive automation layer that copies Zoom names into its variants) will overwrite the name and title; remove them from your layer sets when you use this. The source goes into the slot *before* the layer set is recalled, so the layout comes up with the right people in it. Slots are set through the layer's `tvIn_VideoSource<slot>Image` input. Cues only act when they fire, so the TD can change sources and layouts in mimoLive at any time.

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
