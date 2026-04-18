/*!
 * djappR1 Beatmatch v2.0 — iOS compatible
 *
 * Approccio buffer-based (funziona indipendentemente dal layout mobile/desktop):
 *   1. Intercetta ogni AudioBuffer assegnato a un BufferSource.
 *   2. Analizza il BPM di ciascun buffer con un worker interno (clone
 *      di bpmDetector) una volta sola per buffer.
 *   3. Traccia fino a 2 "slot" (1 e 2) in ordine di apparizione.
 *   4. Calcola BPM effettivo = BPM originale × playbackRate del source attivo.
 *
 * Niente dipendenza dal DOM React: su iPhone dove i deck sono tab-based
 * (un solo deck visibile alla volta) il vecchio approccio basato su
 * `[class*="_bpmValue"]` non trovava mai 2 span e il beatmatch restava "—".
 *
 * (c) PezzaliApp
 */
(function () {
  'use strict';
  if (window.__djappBeatmatch) return;
  window.__djappBeatmatch = true;

  var OrigCtx = window.AudioContext || window.webkitAudioContext;
  if (!OrigCtx) { console.warn('[Beatmatch v2] no AudioContext'); return; }

  // ============================================================
  //  Worker BPM inline (stesso algoritmo di bpmDetector.worker)
  // ============================================================
  var workerSrc = [
    'self.onmessage=function(o){',
    '  if(o.data.type!=="ANALYZE")return;',
    '  var e=o.data.sampleRate, n=o.data.channelData;',
    '  try{ var t=compute(n,e); self.postMessage({type:"RESULT",bpm:t}); }',
    '  catch(x){ self.postMessage({type:"ERROR",message:x.message}); }',
    '};',
    'function compute(o,e){',
    '  var t=e/10, l=downs(o,10), s=rms(l,Math.floor(t*.01));',
    '  var a=Math.floor(t*60/200), i=Math.floor(t*60/60);',
    '  var u=Math.min(s.length,Math.floor(t*30));',
    '  var M=a,g=-Infinity,f,h,c;',
    '  for(f=a;f<=i;f++){ c=0; for(h=0;h<u-f;h++) c+=s[h]*s[h+f]; if(c>g){g=c;M=f;} }',
    '  var r=60*t/M;',
    '  while(r<80) r*=2;',
    '  while(r>160) r/=2;',
    '  return Math.round(r*10)/10;',
    '}',
    'function downs(o,e){',
    '  var n=new Float32Array(Math.floor(o.length/e)),t,l,s;',
    '  for(t=0;t<n.length;t++){ l=0; for(s=0;s<e;s++) l+=Math.abs(o[t*e+s]||0); n[t]=l/e; }',
    '  return n;',
    '}',
    'function rms(o,e){',
    '  var n=new Float32Array(Math.floor(o.length/e)),t,l,s,a;',
    '  for(t=0;t<n.length;t++){ l=0; s=t*e; for(a=0;a<e;a++) l+=(o[s+a]||0)*(o[s+a]||0); n[t]=Math.sqrt(l/e); }',
    '  return n;',
    '}'
  ].join('\n');
  var workerUrl = URL.createObjectURL(new Blob([workerSrc], { type: 'application/javascript' }));

  // ============================================================
  //  State tracking
  // ============================================================
  var bufferBpm = new WeakMap(); // AudioBuffer -> bpm (cached)
  var pending = new WeakSet();   // buffers in analisi
  var slots = [null, null];      // { buffer, bpm } × 2
  var sources = [];              // entries: { node, buffer, startedAt, ended }
  var lastStartedSlot = -1;      // ultimo slot messo in play (per distinguere A/B)

  function analyzeBpm(buffer) {
    if (!buffer || buffer.length === 0) return;
    if (bufferBpm.has(buffer) || pending.has(buffer)) {
      if (bufferBpm.has(buffer)) assignSlot(buffer, bufferBpm.get(buffer));
      return;
    }
    pending.add(buffer);
    var w;
    try {
      w = new Worker(workerUrl);
    } catch (e) {
      pending.delete(buffer);
      return;
    }
    var timer = setTimeout(function () {
      pending.delete(buffer);
      try { w.terminate(); } catch (e) {}
    }, 10000);
    w.onmessage = function (ev) {
      clearTimeout(timer);
      pending.delete(buffer);
      if (ev.data && ev.data.type === 'RESULT' && typeof ev.data.bpm === 'number') {
        bufferBpm.set(buffer, ev.data.bpm);
        assignSlot(buffer, ev.data.bpm);
      }
      try { w.terminate(); } catch (e) {}
    };
    w.onerror = function () {
      clearTimeout(timer);
      pending.delete(buffer);
      try { w.terminate(); } catch (e) {}
    };
    // Copia canale 0 (transferable per evitare copie grandi)
    var src = buffer.getChannelData(0);
    var copy = new Float32Array(src);
    try {
      w.postMessage(
        { type: 'ANALYZE', sampleRate: buffer.sampleRate, channelData: copy },
        [copy.buffer]
      );
    } catch (e) {
      w.postMessage({ type: 'ANALYZE', sampleRate: buffer.sampleRate, channelData: copy });
    }
  }

  function assignSlot(buffer, bpm) {
    // Già in uno slot? aggiorna e basta.
    for (var i = 0; i < 2; i++) {
      if (slots[i] && slots[i].buffer === buffer) { slots[i].bpm = bpm; return; }
    }
    // Slot vuoto?
    if (!slots[0]) { slots[0] = { buffer: buffer, bpm: bpm }; return; }
    if (!slots[1]) { slots[1] = { buffer: buffer, bpm: bpm }; return; }
    // Entrambi pieni → rimpiazza quello usato meno di recente (LRU per startedAt).
    var lastA = 0, lastB = 0, k;
    for (k = 0; k < sources.length; k++) {
      var src = sources[k];
      if (!src.buffer || src.ended) continue;
      if (src.buffer === slots[0].buffer && src.startedAt > lastA) lastA = src.startedAt;
      if (src.buffer === slots[1].buffer && src.startedAt > lastB) lastB = src.startedAt;
    }
    slots[lastA < lastB ? 0 : 1] = { buffer: buffer, bpm: bpm };
  }

  // ============================================================
  //  Hook AudioContext.createBufferSource
  // ============================================================
  var origCreate = OrigCtx.prototype.createBufferSource;

  // Property descriptor "buffer" di AudioBufferSourceNode (una volta sola)
  var bufferDesc = null;
  try {
    bufferDesc =
      (typeof AudioBufferSourceNode !== 'undefined' &&
        Object.getOwnPropertyDescriptor(AudioBufferSourceNode.prototype, 'buffer')) ||
      null;
  } catch (e) {}

  OrigCtx.prototype.createBufferSource = function () {
    var node = origCreate.call(this);
    var entry = { node: node, buffer: null, startedAt: 0, ended: false, slotIdx: -1 };
    sources.push(entry);
    if (sources.length > 120) sources.splice(0, sources.length - 120);

    // Intercetta il set di .buffer per triggerare l'analisi BPM
    if (bufferDesc && bufferDesc.set) {
      try {
        Object.defineProperty(node, 'buffer', {
          configurable: true,
          enumerable: true,
          get: function () { return bufferDesc.get ? bufferDesc.get.call(this) : null; },
          set: function (b) {
            bufferDesc.set.call(this, b);
            if (b) { entry.buffer = b; analyzeBpm(b); }
          }
        });
      } catch (e) { /* alcuni engine rifiutano defineProperty: fallback su start() */ }
    }

    var origStart = node.start.bind(node);
    node.start = function () {
      entry.startedAt = performance.now();
      if (!entry.buffer) {
        try {
          var b = bufferDesc && bufferDesc.get ? bufferDesc.get.call(node) : node.buffer;
          if (b) { entry.buffer = b; analyzeBpm(b); }
        } catch (e) {}
      }
      // Registra quale slot ha fatto l'ultimo start (utile per label A/B)
      for (var i = 0; i < 2; i++) {
        if (slots[i] && slots[i].buffer === entry.buffer) {
          entry.slotIdx = i;
          lastStartedSlot = i;
          break;
        }
      }
      return origStart.apply(null, arguments);
    };
    node.addEventListener('ended', function () { entry.ended = true; });
    return node;
  };

  // ============================================================
  //  Live BPM per slot
  // ============================================================
  function liveForSlot(slotIdx) {
    if (!slots[slotIdx]) return null;
    var target = slots[slotIdx].buffer;
    var best = null;
    for (var k = sources.length - 1; k >= 0; k--) {
      var s = sources[k];
      if (s.ended || !s.startedAt) continue;
      if (s.buffer === target) {
        if (!best || s.startedAt > best.startedAt) best = s;
      }
    }
    var rate = best ? best.node.playbackRate.value : 1.0;
    return {
      orig: slots[slotIdx].bpm,
      rate: rate,
      eff: slots[slotIdx].bpm * rate,
      playing: !!best,
      source: best ? best.node : null
    };
  }

  // ============================================================
  //  UI overlay (draggable, collapsible)
  // ============================================================
  var ui = null;
  var POS_KEY = 'djappr1_bm_pos';
  var COLLAPSED_KEY = 'djappr1_bm_collapsed';

  function loadPos() {
    try {
      var raw = localStorage.getItem(POS_KEY);
      if (!raw) return null;
      var p = JSON.parse(raw);
      if (typeof p.x === 'number' && typeof p.y === 'number') return p;
    } catch (e) {}
    return null;
  }
  function savePos(x, y) {
    try { localStorage.setItem(POS_KEY, JSON.stringify({ x: x, y: y })); } catch (e) {}
  }
  function loadCollapsed() {
    try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch (e) { return false; }
  }
  function saveCollapsed(v) {
    try { localStorage.setItem(COLLAPSED_KEY, v ? '1' : '0'); } catch (e) {}
  }
  function clampX(x, w) { return Math.max(0, Math.min(window.innerWidth - (w || 180), x)); }
  function clampY(y, h) { return Math.max(0, Math.min(window.innerHeight - (h || 100), y)); }

  function renderUI() {
    if (ui || !document.body) return;

    var style = document.createElement('style');
    style.textContent = [
      '#djapp-bm{position:fixed;z-index:2147483646;',
      'background:#0d0d0d;color:#fff;border:1px solid #4a9eff;border-radius:8px;',
      'font:500 10px/1.35 -apple-system,system-ui,sans-serif;',
      'box-shadow:0 4px 14px rgba(0,0,0,.4);user-select:none;min-width:150px;',
      'max-width:calc(100vw - 20px)}',
      '#djapp-bm .hdr{display:flex;align-items:center;gap:6px;padding:5px 8px;',
      'cursor:grab;border-radius:7px 7px 0 0;background:rgba(74,158,255,.08)}',
      '#djapp-bm .hdr:active{cursor:grabbing}',
      '#djapp-bm.collapsed .hdr{border-radius:7px}',
      '#djapp-bm .ttl{color:#4a9eff;font-weight:700;font-size:9px;letter-spacing:.06em;',
      'text-transform:uppercase;flex:1}',
      '#djapp-bm .hd-delta{color:#e8ff47;font-variant-numeric:tabular-nums;font-weight:600}',
      '#djapp-bm .tgl{background:none;border:0;color:#4a9eff;cursor:pointer;',
      'font-size:12px;padding:0 2px;line-height:1}',
      '#djapp-bm .body{padding:6px 8px 8px}',
      '#djapp-bm.collapsed .body{display:none}',
      '#djapp-bm .row{display:flex;justify-content:space-between;gap:10px;padding:1px 0}',
      '#djapp-bm .v{font-variant-numeric:tabular-nums}',
      '#djapp-bm .d{color:#e8ff47;font-weight:600}',
      '#djapp-bm .dot{display:inline-block;width:6px;height:6px;border-radius:50%;',
      'background:#555;margin-right:4px;vertical-align:middle}',
      '#djapp-bm .dot.on{background:#7fff7f;box-shadow:0 0 4px #7fff7f}',
      '#djapp-bm .btns{display:flex;gap:4px;margin-top:6px}',
      '#djapp-bm button.sync{flex:1;border:1px solid #4a9eff;background:transparent;',
      'color:#4a9eff;padding:4px 6px;border-radius:5px;cursor:pointer;',
      'font:600 10px/1 inherit}',
      '#djapp-bm button.sync:hover{background:#4a9eff;color:#0d0d0d}',
      '#djapp-bm button.sync:disabled{opacity:.35;cursor:not-allowed}'
    ].join('');
    document.head.appendChild(style);

    var wrap = document.createElement('div');
    wrap.id = 'djapp-bm';
    wrap.innerHTML =
      '<div class="hdr">' +
        '<span class="ttl">Beatmatch</span>' +
        '<span class="hd-delta" id="bm-hd-d">—</span>' +
        '<button class="tgl" id="bm-tgl" title="Mostra/nascondi">▾</button>' +
      '</div>' +
      '<div class="body">' +
        '<div class="row"><span><span class="dot" id="bm-dot-a"></span>Track 1</span><span class="v" id="bm-a">—</span></div>' +
        '<div class="row"><span><span class="dot" id="bm-dot-b"></span>Track 2</span><span class="v" id="bm-b">—</span></div>' +
        '<div class="row"><span>Δ effettivo</span><span class="v d" id="bm-d">—</span></div>' +
        '<div class="btns">' +
          '<button class="sync" id="bm-sync-ba">SYNC 2→1</button>' +
          '<button class="sync" id="bm-sync-ab">SYNC 1→2</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    var saved = loadPos();
    if (saved) {
      wrap.style.left = clampX(saved.x, wrap.offsetWidth) + 'px';
      wrap.style.top = clampY(saved.y, wrap.offsetHeight) + 'px';
    } else {
      wrap.style.left = '16px';
      wrap.style.top = '60px';
    }
    if (loadCollapsed()) wrap.classList.add('collapsed');

    ui = {
      wrap: wrap,
      a: wrap.querySelector('#bm-a'),
      b: wrap.querySelector('#bm-b'),
      dotA: wrap.querySelector('#bm-dot-a'),
      dotB: wrap.querySelector('#bm-dot-b'),
      d: wrap.querySelector('#bm-d'),
      hdD: wrap.querySelector('#bm-hd-d'),
      syncBA: wrap.querySelector('#bm-sync-ba'),
      syncAB: wrap.querySelector('#bm-sync-ab'),
      tgl: wrap.querySelector('#bm-tgl'),
      hdr: wrap.querySelector('.hdr')
    };

    ui.tgl.addEventListener('click', function (e) {
      e.stopPropagation();
      var c = wrap.classList.toggle('collapsed');
      saveCollapsed(c);
      ui.tgl.textContent = c ? '▸' : '▾';
    });
    ui.tgl.textContent = wrap.classList.contains('collapsed') ? '▸' : '▾';

    // Drag (mouse + touch)
    var drag = null;
    ui.hdr.addEventListener('mousedown', function (e) {
      if (e.target === ui.tgl) return;
      var r = wrap.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!drag) return;
      wrap.style.left = clampX(e.clientX - drag.dx, wrap.offsetWidth) + 'px';
      wrap.style.top = clampY(e.clientY - drag.dy, wrap.offsetHeight) + 'px';
    });
    document.addEventListener('mouseup', function () {
      if (!drag) return;
      var r = wrap.getBoundingClientRect();
      savePos(r.left, r.top);
      drag = null;
    });
    ui.hdr.addEventListener('touchstart', function (e) {
      if (e.target === ui.tgl) return;
      var t = e.touches[0];
      var r = wrap.getBoundingClientRect();
      drag = { dx: t.clientX - r.left, dy: t.clientY - r.top };
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (!drag) return;
      var t = e.touches[0];
      wrap.style.left = clampX(t.clientX - drag.dx, wrap.offsetWidth) + 'px';
      wrap.style.top = clampY(t.clientY - drag.dy, wrap.offsetHeight) + 'px';
    }, { passive: true });
    document.addEventListener('touchend', function () {
      if (!drag) return;
      var r = wrap.getBoundingClientRect();
      savePos(r.left, r.top);
      drag = null;
    });

    ui.syncBA.addEventListener('click', function () { doSync('21'); });
    ui.syncAB.addEventListener('click', function () { doSync('12'); });
  }

  // ============================================================
  //  Tick loop — aggiorna UI ~6 volte al secondo
  // ============================================================
  function fmt(n) { return n == null ? '—' : n.toFixed(2); }

  function tick() {
    if (!ui) return;
    var a = liveForSlot(0);
    var b = liveForSlot(1);

    if (a) {
      var txt = fmt(a.eff);
      if (Math.abs(a.rate - 1) > 0.0005) txt += ' (' + ((a.rate - 1) * 100).toFixed(1) + '%)';
      ui.a.textContent = txt;
      ui.dotA.classList.toggle('on', a.playing);
    } else { ui.a.textContent = '—'; ui.dotA.classList.remove('on'); }

    if (b) {
      var txt2 = fmt(b.eff);
      if (Math.abs(b.rate - 1) > 0.0005) txt2 += ' (' + ((b.rate - 1) * 100).toFixed(1) + '%)';
      ui.b.textContent = txt2;
      ui.dotB.classList.toggle('on', b.playing);
    } else { ui.b.textContent = '—'; ui.dotB.classList.remove('on'); }

    if (a && b) {
      var delta = Math.abs(a.eff - b.eff).toFixed(2);
      ui.d.textContent = delta;
      ui.hdD.textContent = 'Δ' + delta;
    } else {
      ui.d.textContent = '—';
      ui.hdD.textContent = '—';
    }

    var both = !!(a && b && a.playing && b.playing);
    ui.syncBA.disabled = !both;
    ui.syncAB.disabled = !both;
  }

  // ============================================================
  //  SYNC — allinea il BPM di uno slot a quello dell'altro
  // ============================================================
  function doSync(dir) {
    var a = liveForSlot(0);
    var b = liveForSlot(1);
    if (!a || !b || !a.source || !b.source) {
      alert('Servono entrambi i deck in play per sincronizzare');
      return;
    }
    if (dir === '21') {
      // Allinea Track 2 a Track 1
      var newRate2 = Math.max(0.5, Math.min(2.0, a.eff / b.orig));
      b.source.playbackRate.setValueAtTime(newRate2, b.source.context.currentTime);
      console.log('[Beatmatch v2] SYNC 2→1: rate2=' + newRate2.toFixed(4));
    } else {
      // Allinea Track 1 a Track 2
      var newRate1 = Math.max(0.5, Math.min(2.0, b.eff / a.orig));
      a.source.playbackRate.setValueAtTime(newRate1, a.source.context.currentTime);
      console.log('[Beatmatch v2] SYNC 1→2: rate1=' + newRate1.toFixed(4));
    }
  }

  // ============================================================
  //  Boot
  // ============================================================
  function start() {
    renderUI();
    setInterval(tick, 160);
    console.log('[Beatmatch v2.0] attivo — buffer-based, iOS compatible');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
