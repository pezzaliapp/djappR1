# Changelog djappR1

## v1.0.0 — 2026-04-18

Fork iniziale da **pezzaliapp/djapp-new** commit `ff16b34` (v1.7.0 + sw.js v1.7.1).

### Fix

- **[iOS] Beatmatch ora funziona su iPhone.** Il bundle React attiva un layout mobile tab-based sotto 600 px di larghezza, dove è visibile un solo deck alla volta. Il vecchio `beatmatch.js` v1.1 cercava due span `[class*="_bpmValue"]` nel DOM per catturare i BPM originali — su mobile ne trovava sempre uno solo e `captureOriginals()` falliva silenziosamente. Riscritto con approccio buffer-based completamente indipendente dal DOM (`beatmatch.js` v2.0).
- **[Mobile] Pulsante REC non si sovrappone più alla mobile nav.** Su mobile la tab bar è alta 52 px e il REC (posizionato a `bottom:16px`) cadeva sopra "DECK B" e "LIBRARY". CSS rifatto con media query: su `max-width:600px` il REC sale a `calc(60px + env(safe-area-inset-bottom))` e diventa una pill più grande (touch target 36 px). Su `max-width:360px` il contatore tempo viene nascosto per non affollare schermi molto stretti.

### Modifiche al bundle

- `assets/index-N51-MIQm.js`: l'unico path hardcoded `"/djapp/assets/bpmDetector.worker-BB5Y_730.js"` è stato sostituito con `"./bpmDetector.worker-BB5Y_730.js"` via `sed`. Nessuna ricompilazione Vite. Il bundle resta per il resto identico al commit `ff16b34`.

### Invariati

- `assets/index-DJw73BJx.css` — mai ricompilato (come da prassi del progetto)
- `assets/react-core-Z7GUA4v1.js`, `assets/zustand-CtSZPRb0.js` — byte-identici
- `assets/bpmDetector.worker-BB5Y_730.js` — byte-identico
- `LICENSE`, `MANUAL.*`, icone

### Metadati

- `package.json`: `name: "djappr1"`, `version: "1.0.0"`
- `manifest.json`: `name: "djappR1 by PezzaliApp"`, `scope: "./"`, `start_url: "./"`
- `sw.js`: `APP_VERSION = 'djappr1-v1.0.0'` (cache completamente separata da djapp-new, no conflitti)
