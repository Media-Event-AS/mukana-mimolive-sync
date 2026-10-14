# Mukana → mimoLive Sync (v3, uten nettleser)

Headless Node-tjeneste som leser det aktive spørsmålet direkte fra Mukanas Firebase Realtime Database og skriver det til mimoLive-lag via HTTP-API-et. Ingen Chrome, ingen plugin, ingen DOM-skraping.

```
Mukana (Firebase RTDB) ──SSE──▶ denne tjenesten ──HTTP──▶ mimoLive :8989
                                     ▲
                              web-UI :8790 (LAN)
```

## Krav
- Node.js 18.17+ (ingen npm-avhengigheter)
- En Mukana-bruker med **host**-rolle på eventet
- mimoLive med *Allow Remote Control* på (Preferences → Remote Control)
- Maskinen må nå mimoLive-maskinen på LAN og internett (Firebase)

## Start
```bash
cd service
UI_PASSWORD=velg-et-passord npm start
# åpne http://<maskin-ip>:8790
```
| Env | Default | |
|---|---|---|
| `PORT` | 8790 | Web-UI-port |
| `HOST` | 0.0.0.0 | Bind-adresse |
| `UI_PASSWORD` | – | Basic auth for UI (anbefalt, UI-et styrer en innlogget Mukana-sesjon) |
| `DATA_DIR` | `service/data` | Hvor `config.json` lagres (inneholder refresh-token, filmodus 600) |

## Oppsett i web-UI
1. **Mukana:** Event-ID (f.eks. `ohtest`) + refresh-token.
   Hent tokenet: logg inn på Mukana panelView i Chrome/Safari, åpne DevTools-konsollen og kjør
   `copy(firebase.auth().currentUser.refreshToken)` – lim inn. Tokenet fornyes automatisk hver time.
   Logger du ut av Google-kontoen/tilbakekaller tilgang, må nytt token limes inn.
2. **mimoLive:** «Søk i nettverket» skanner lokale /24-nett på port 8989, eller skriv inn IP. Velg dokument.
3. **Mapping:** Velg Mukana-felt → lag/kilde → input-felt. Lag og input-felt hentes fra mimoLive.
4. **Start sync.** Status, gjeldende verdier og logg vises under *Live*. Tjenesten autostarter etter omstart hvis den var startet.

## Felter
| Felt | Kilde i RTDB |
|---|---|
| Navn | `qs_liveQ/{event}/n` |
| Spørsmål (uten URL) / original | `qs_liveQ/{event}/q` |
| Sted | `qs_liveQ/{event}/l` |
| Tag | `qs_liveQ/{event}/tag` |
| Stemmer | `qs_liveQ/{event}/v` |
| URL (QR) | første URL i `q` |
| Panelist-kø | `panel_hands/{event}/{key}/array[]` med `st=q` («2. Anne, 3. Per») |
| Aktiv panelist | samme, `st=a` |

Når ingen spørsmål er aktive (noden slettes) tømmes alle mappede felt. Kun endrede verdier sendes.

## Kjør som tjeneste (macOS launchd)
Rediger stier i `launchd/no.mediaevent.mukana-sync.plist`, deretter:
```bash
cp launchd/no.mediaevent.mukana-sync.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/no.mediaevent.mukana-sync.plist
```

## Test
`npm test` – enhetstester + ende-til-ende mot mock Firebase og mock mimoLive.

## Begrensninger
- Datastrukturen i Mukana er udokumentert (kartlagt fra panelView v260113a). Endrer Mukana stiene, må `src/sync.js` oppdateres.
- Firebase-konfig (API-key, database-URL, origin) kan endres under *Avansert* hvis en annen Mukana-instans brukes.
