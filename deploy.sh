#!/bin/bash
set -e
echo ">>> Deploy djappR1..."
git add -A
git commit -m "deploy $(date +%Y-%m-%d)"
git push origin main
echo ""
echo "✅ Deploy completato!"
echo "→ https://pezzaliapp.github.io/djappR1/ (GitHub Pages)"
echo "→ oppure il tuo URL Cloudflare Pages se connesso"
