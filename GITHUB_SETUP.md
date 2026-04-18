# Come creare il repo djappR1 su GitHub

## 1. Crea il repo vuoto su GitHub

Vai su **https://github.com/new** e crea:
- Repository name: **`djappR1`** (owner: `pezzaliapp`)
- Description: *Fork R1 di djApp — iOS beatmatch fix + REC responsive*
- Public
- **NON** aggiungere README, .gitignore, LICENSE (li abbiamo già)

Clicca "Create repository" e lascia aperta la pagina.

## 2. Estrai lo zip e inizializza Git

```bash
cd ~/Downloads
unzip djappR1.zip
cd djappR1

git init
git add .
git commit -m "djappR1 v1.0.0 — fork from djapp-new ff16b34: iOS beatmatch + REC responsive"
git branch -M main
git remote add origin https://github.com/pezzaliapp/djappR1.git
git push -u origin main
```

Se Git ti chiede credenziali, usa il Personal Access Token come al solito (Settings → Developer settings → Personal access tokens).

## 3. Attiva il deploy

### Opzione A — GitHub Pages
Sul repo GitHub: **Settings → Pages → Source: Deploy from a branch → Branch: `main` / `(root)`** → Save.
URL risultante: `https://pezzaliapp.github.io/djappR1/`

### Opzione B — Cloudflare Pages
1. https://dash.cloudflare.com → Workers & Pages → Create → Pages → Connect to Git
2. Seleziona `pezzaliapp/djappR1`
3. Build settings:
   - Framework preset: **None**
   - Build command: *(vuoto)*
   - Build output directory: `/` (root)
4. Deploy. Assegna un subdomain o custom domain tipo `djappr1.alessandropezzali.it`.

Non serve `npm run build` perché il bundle React è già precompilato in `assets/`.

## 4. Test iPhone

1. Apri `https://pezzaliapp.github.io/djappR1/` (o il tuo URL Cloudflare) su iPhone Safari
2. Aggiungi alla home (icona Condividi → Aggiungi a Home)
3. Apri la PWA installata
4. Carica una traccia su Deck A, cambia tab e carica una traccia diversa su Deck B
5. Torna su Deck A e metti PLAY; poi vai su Deck B e metti PLAY
6. Il pannello **Beatmatch** in alto a sinistra deve ora mostrare:
   - Track 1 con BPM numerico (pallino verde quando suona)
   - Track 2 con BPM numerico (pallino verde quando suona)
   - Δ effettivo calcolato
   - Bottoni SYNC 2→1 e SYNC 1→2 attivi
7. Il pulsante **REC** giallo deve stare sopra la mobile nav, non sopra DECK B / LIBRARY

## 5. Se qualcosa non torna

Su Mac Safari, con l'iPhone collegato via cavo (o senza cavo, includendo temporaneamente `diag.js` generato in precedenza), verifica:
- Console log: `[Beatmatch v2.0] attivo — buffer-based, iOS compatible` deve comparire
- Nel panel Beatmatch: le due righe Track 1 / Track 2 si popolano progressivamente man mano che il worker finisce l'analisi BPM (~1-3 secondi per traccia)

Se Track 1/2 restano `—` dopo aver messo in play: il hook su `createBufferSource` non sta agendo. Possibile causa: `recorder.js` rimpiazza `window.AudioContext` PRIMA di `beatmatch.js`. Nell'`index.html` di djappR1 l'ordine è corretto (`recorder.js` prima, `beatmatch.js` dopo), quindi `beatmatch.js` patcha il `PatchedCtx` di recorder — deve funzionare. Se non va, inverti l'ordine dei due `<script>` in `index.html` come test.
