# djappR1

Fork **R1** di [djApp](https://github.com/pezzaliapp/djapp-new) di [PezzaliApp](https://pezzaliapp.com) con due fix focalizzati:

1. **Beatmatch funzionante su iPhone** — riscritto da DOM-based a buffer-based, così funziona anche in layout mobile tab-based dove è visibile un solo deck alla volta.
2. **Pulsante REC responsive** — non si sovrappone più alla mobile nav (DECK A / MIXER / DECK B / LIBRARY); touch target ≥ 36 px; rispetta `safe-area-inset`.

Il bundle React/Vite è invariato e viene conservato al commit originale (`ff16b34`, v1.7.0 + sw.js v1.7.1 audio fix). L'unica modifica al bundle è il path relativo del worker BPM (`./bpmDetector.worker-BB5Y_730.js` invece di `/djapp/...`) per rendere il progetto self-contained e deployabile a qualunque path.

## Anatomia

```
djappR1/
├── index.html                  ← riferimenti relativi ./assets/
├── assets/
│   ├── index-DJw73BJx.css      ← invariato dal commit ff16b34
│   ├── index-N51-MIQm.js       ← invariato ECCETTO path worker relativo
│   ├── react-core-Z7GUA4v1.js  ← invariato
│   ├── zustand-CtSZPRb0.js     ← invariato
│   └── bpmDetector.worker-BB5Y_730.js  ← invariato
├── beatmatch.js                ← v2.0 buffer-based (RISCRITTO)
├── recorder.js                 ← v1.1 mobile-responsive (CSS aggiornato)
├── sw.js                       ← cache name djappr1-v1.0.0
├── manifest.json               ← PWA djappR1
├── package.json                ← name djappr1
└── icon-*.png, icon.svg
```

## Differenze vs djapp-new

### `beatmatch.js` — riscritto da capo (v1.1 → v2.0)

**Bug originale (iOS):** il layout mobile dell'app attiva uno stato `h.useState(() => window.innerWidth <= 600)` che mostra **un solo deck alla volta** (tab-based). Il vecchio `beatmatch.js` cercava `[class*="_bpmValue"]` nel DOM aspettandosi 2 span unici. Su iPhone ne trovava sempre 1 → `captureOriginals()` non si attivava mai → BEATMATCH restava `—`.

**Fix:** nuovo approccio buffer-based indipendente dal DOM:
- intercetta `AudioContext.createBufferSource` e il setter di `.buffer`
- per ogni nuovo `AudioBuffer` avvia un worker interno (clone di `bpmDetector`) che calcola il BPM originale una volta sola
- mantiene 2 slot (Track 1 / Track 2) aggiornati con strategia LRU
- calcola il BPM effettivo come `orig × source.playbackRate.value`
- funziona identico su Mac (layout 2-deck) e iPhone (layout tab)

### `recorder.js` — UI responsive (v1.0 → v1.1)

**Problema:** pulsante REC hardcoded a `bottom:16px; right:16px` si sovrapponeva a "DECK B" e "LIBRARY" nella mobile nav (alta 52 px).

**Fix:** CSS rifatto con media query:
- default (desktop): stessa posizione `bottom:16px; right:16px` + `env(safe-area-inset-*)`
- `@media (max-width: 600px)`: alzato a `bottom: calc(60px + env(safe-area-inset-bottom))`, forma pill più grande, touch target ≥ 36 px
- `@media (max-width: 360px)`: nasconde il contatore tempo su schermi molto stretti

### Bundle (`assets/index-N51-MIQm.js`)

Una sola modifica textuale: `"/djapp/assets/bpmDetector.worker-BB5Y_730.js"` → `"./bpmDetector.worker-BB5Y_730.js"`. Nessuna ricompilazione.

## Deploy

### Cloudflare Pages
```bash
# Dopo git push, Cloudflare builda automaticamente se connesso al repo.
# Non serve build: pubblica direttamente la root.
```

### GitHub Pages
```bash
git push origin main
# Settings → Pages → Source: main branch, root folder
# URL: https://pezzaliapp.github.io/djappR1/
```

Funziona a qualunque path perché `index.html` usa riferimenti relativi `./` e il worker nel bundle è relativo.

## Come creare il repo su GitHub

Dopo aver estratto lo zip:

```bash
cd djappR1
git init
git add .
git commit -m "djappR1 v1.0.0 — fork from djapp-new ff16b34: iOS beatmatch + REC responsive"
git branch -M main
git remote add origin https://github.com/pezzaliapp/djappR1.git
git push -u origin main
```

Il repo `pezzaliapp/djappR1` va creato prima su GitHub (vuoto, senza README auto-generato).

## Credits

djApp originale: [pezzaliapp/djapp-new](https://github.com/pezzaliapp/djapp-new) · Alessandro Pezzali / PezzaliApp
Fork R1: stesse licenze del progetto originale (vedi `LICENSE`).
