# Mukana → mimoLive Sync (v3, no browser)

Headless Node service that reads the live question directly from Mukana's Firebase Realtime Database and writes it to mimoLive layers via the HTTP API. No Chrome, no extension, no DOM scraping.

```
Mukana (Firebase RTDB) ──SSE──▶ this service ──HTTP──▶ mimoLive :8989
                                     ▲
                              web UI :8790 (LAN)
```

## Requirements
- Node.js 18.17+ (no npm dependencies)
- A Mukana user with the **host** role on the event
- mimoLive with *Allow Remote Control* enabled (Preferences → Remote Control)
- The machine must reach the mimoLive machine on the LAN and the internet (Firebase)

## Run
```bash
cd service
npm start
# open http://<machine-ip>:8790
```
| Env | Default | |
|---|---|---|
| `PORT` | 8790 | Web UI port |
| `HOST` | 0.0.0.0 | Bind address |
| `UI_PASSWORD` | – | Optional password for the web UI (login page + cookie; Basic auth accepted for scripts) |
| `DATA_DIR` | `service/data` | Where `config.json` is stored (contains the refresh token, file mode 600) |
| `TZ` | system | Time zone for the HH:MM fields |

## Setup in the web UI
1. **Mukana:** Event ID (e.g. `ohtest`) + refresh token.
   Get the token: sign in to Mukana panelView in Chrome/Safari, open the DevTools console and run
   `copy(firebase.auth().currentUser.refreshToken)` (prints `undefined`, the token is on the clipboard) and paste it. The token renews automatically every hour.
2. **mimoLive:** *Scan network* scans local /24 subnets on port 8989, or enter the IP. Pick the document.
3. **Mapping:** Mukana field → layer/source → input key. Layers and input keys are loaded from mimoLive.
4. **Start sync.** Status, current values and log appear under *Live*. *Verify against mimoLive* reads values back from every mapped layer. The service auto-starts after a restart if it was running.

## Fields
| Group | Field | RTDB source |
|---|---|---|
| Question | Name, Question, Location, Tag, Votes | `qs_liveQ/{event}` (`n`, `q`, `l`, `tag`, `v` – votes stored negated, shown positive) |
| | Country code / flag emoji | `loc_cc` |
| | URL (QR) | first URL in `q` |
| | Host notes | `comments_host_output/{event}/{key}/hostNotes` |
| | Source (raw / label) | `…/source`: `mukana`/`lite` Mobile, `full` Web, `form` QR form, `panel` Panel, `chat`, `facebook`, `youtube`, `twitter` |
| | Name / location phonetics | `…/namePho`, `…/locPho` |
| | Asked at, Answering since | `…/ts_created`, `…/ts_answered` |
| | Done reading | `qs_liveQ/{event}/rd` |
| Panel | Panelist queue, Active panelist | `panel_hands/{event}/{key}/array[]` (`st` = q/a/c) |
| | Panelists online | `panel_onlinelist/{event}` |
| Rundown | Questions waiting, On deck name/question | `comments_host_output/{event}` sorted by `orderID` |

When no question is live, all question/panel fields are cleared; rundown fields stay updated. Only changed values are sent.

## Run as a service (macOS launchd)
Edit paths in `launchd/no.mediaevent.mukana-sync.plist`, then:
```bash
cp launchd/no.mediaevent.mukana-sync.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/no.mediaevent.mukana-sync.plist
```

## Test
`npm test` – unit tests + end-to-end against mock Firebase and mock mimoLive.

## Limitations
- Mukana's data structure is undocumented (mapped from panelView v260113a). If Mukana changes its paths, update `src/sync.js`.
- Firebase config (API key, database URL, origin) can be changed under *Advanced* for another Mukana instance.
