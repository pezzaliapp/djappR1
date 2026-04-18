/*!
 * djappR1 Recorder v1.2 — WAV PCM16 stereo, iOS-compatible
 * Intercetta l'AudioContext dell'app, tap sul master, registrazione via AudioWorklet.
 * Nessuna dipendenza. Deve essere caricato PRIMA del bundle React.
 *
 * Changelog v1.2 (vs v1.1):
 *   • [iOS] FIX CRITICO: il worklet è ora connesso a ctx.destination tramite
 *     un GainNode a volume 0. iOS Safari schedula process() di un
 *     AudioWorkletNode SOLO se il nodo ha un percorso verso destination.
 *     Prima su iPhone la registrazione restava a 00:00 e "Nessun audio catturato".
 *   • Uso origConnect salvato in anticipo per bypassare il monkey-patch
 *     sul percorso keep-alive → destination (altrimenti feedback loop).
 *
 * Changelog v1.1:
 *   • UI REC responsive: su mobile (<=600px) sale sopra la mobile nav (60px
 *     + safe-area). Touch target >= 36 px. Rispetta env(safe-area-inset-*).
 *
 * (c) PezzaliApp
 */
(function () {
  'use strict';

  var OrigCtx = window.AudioContext || window.webkitAudioContext;
  if (!OrigCtx) {
    console.warn('[djappR1 Recorder] AudioContext non disponibile');
    return;
  }

  // Salva il VERO connect originale PRIMA di qualunque patch, così può essere
  // usato per bypassare il monkey-patch sul percorso keep-alive iOS.
  var TRUE_CONNECT = AudioNode.prototype.connect;

  var state = {
    ctx: null,
    tap: null,
    worklet: null,
    iosKeepAlive: null,
    recording: false,
    buffers: [],
    totalSamples: 0,
    ui: null
  };

  // -------- Worklet processor (inline via Blob URL) --------
  var workletSrc = [
    'class DjAppRec extends AudioWorkletProcessor {',
    '  constructor(){ super(); this.on=false;',
    '    this.port.onmessage = (e) => {',
    '      if (e.data.cmd === "start") this.on = true;',
    '      else if (e.data.cmd === "stop") this.on = false;',
    '    };',
    '  }',
    '  process(inputs){',
    '    const inp = inputs[0];',
    '    if (this.on && inp && inp.length > 0) {',
    '      const c0 = inp[0] ? new Float32Array(inp[0]) : new Float32Array(128);',
    '      const c1 = inp[1] ? new Float32Array(inp[1]) : new Float32Array(c0);',
    '      this.port.postMessage({c0, c1}, [c0.buffer, c1.buffer]);',
    '    }',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("djapp-rec", DjAppRec);'
  ].join('\n');
  var workletUrl = URL.createObjectURL(new Blob([workletSrc], { type: 'application/javascript' }));

  // -------- Monkey-patch AudioContext --------
  class PatchedCtx extends OrigCtx {
    constructor() {
      super(...arguments);
      if (!state.ctx) {
        state.ctx = this;
        setupTap(this).catch(function (e) { console.error('[djappR1 Recorder] setup:', e); });
      }
    }
  }
  window.AudioContext = PatchedCtx;
  window.webkitAudioContext = PatchedCtx;

  async function setupTap(ctx) {
    // 1. Tap gain in parallelo: riceve tutto l'audio dell'app
    var tap = ctx.createGain();
    tap.gain.value = 1.0;
    tap.connect(ctx.destination); // diretto (pre-patch)
    state.tap = tap;

    // 2. Ridirigi ogni connect(ctx.destination) futuro verso tap (tranne tap stesso)
    AudioNode.prototype.connect = function (target) {
      if (target === ctx.destination && this !== tap) {
        arguments[0] = tap;
      }
      return TRUE_CONNECT.apply(this, arguments);
    };

    // 3. AudioWorklet
    await ctx.audioWorklet.addModule(workletUrl);
    var worklet = new AudioWorkletNode(ctx, 'djapp-rec', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    tap.connect(worklet); // audio dell'app → worklet.input

    // 4. iOS FIX — worklet deve avere un percorso verso destination altrimenti
    //    Safari iOS NON chiama process(). Uso TRUE_CONNECT per evitare che la
    //    patch reindirizzi keepAlive→destination su tap (creerebbe loop
    //    tap→worklet→keepAlive→tap).
    var iosKeepAlive = ctx.createGain();
    iosKeepAlive.gain.value = 0;           // silenzioso, inudibile
    worklet.connect(iosKeepAlive);
    TRUE_CONNECT.call(iosKeepAlive, ctx.destination);
    state.iosKeepAlive = iosKeepAlive;

    // 5. Messaggi dal worklet
    worklet.port.onmessage = function (e) {
      if (!state.recording) return;
      state.buffers.push(e.data);
      state.totalSamples += e.data.c0.length;
      updateTime();
    };
    state.worklet = worklet;

    console.log('[djappR1 Recorder v1.2] Tap armato, sampleRate=' + ctx.sampleRate +
                ', iOS keep-alive attivo');
    renderUI();
  }

  // -------- WAV encoder (PCM 16-bit stereo) --------
  function encodeWAV(buffers, sampleRate) {
    var total = 0;
    for (var i = 0; i < buffers.length; i++) total += buffers[i].c0.length;
    var pcm = new Int16Array(total * 2);
    var off = 0;
    for (var j = 0; j < buffers.length; j++) {
      var c0 = buffers[j].c0, c1 = buffers[j].c1;
      for (var k = 0; k < c0.length; k++) {
        var s0 = c0[k] < -1 ? -1 : c0[k] > 1 ? 1 : c0[k];
        var s1 = c1[k] < -1 ? -1 : c1[k] > 1 ? 1 : c1[k];
        pcm[off++] = s0 < 0 ? s0 * 0x8000 : s0 * 0x7FFF;
        pcm[off++] = s1 < 0 ? s1 * 0x8000 : s1 * 0x7FFF;
      }
    }
    var dataSize = pcm.byteLength;
    var buf = new ArrayBuffer(44 + dataSize);
    var dv = new DataView(buf);
    function w(o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); }
    w(0, 'RIFF');
    dv.setUint32(4, 36 + dataSize, true);
    w(8, 'WAVE');
    w(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, 2, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * 4, true);
    dv.setUint16(32, 4, true);
    dv.setUint16(34, 16, true);
    w(36, 'data');
    dv.setUint32(40, dataSize, true);
    new Int16Array(buf, 44).set(pcm);
    return new Blob([buf], { type: 'audio/wav' });
  }

  // -------- UI overlay (mobile-responsive) --------
  function renderUI() {
    if (document.getElementById('djapp-rec-ui')) return;
    if (!document.body) { document.addEventListener('DOMContentLoaded', renderUI); return; }

    var style = document.createElement('style');
    style.textContent = [
      '#djapp-rec-ui{',
        'position:fixed;',
        'right:calc(16px + env(safe-area-inset-right));',
        'bottom:calc(16px + env(safe-area-inset-bottom));',
        'z-index:2147483647;',
        'display:flex;align-items:center;gap:8px;',
        'padding:8px 12px;border-radius:10px;',
        'background:#0d0d0d;color:#fff;border:1px solid #e8ff47;',
        'font:500 12px/1 -apple-system,system-ui,sans-serif;',
        'box-shadow:0 6px 18px rgba(0,0,0,.4);',
        'touch-action:manipulation;',
      '}',
      '#djapp-rec-ui button{',
        'border:0;border-radius:6px;padding:6px 10px;cursor:pointer;',
        'font:600 12px/1 inherit;background:#e8ff47;color:#0d0d0d;',
        'min-height:30px;min-width:64px;',
        'touch-action:manipulation;-webkit-tap-highlight-color:transparent;',
      '}',
      '#djapp-rec-ui button.on{background:#ff3344;color:#fff}',
      '#djapp-rec-dot{width:8px;height:8px;border-radius:50%;background:#666;flex:0 0 auto}',
      '#djapp-rec-ui.on #djapp-rec-dot{background:#ff3344;animation:djapp-blink 1s infinite}',
      '@keyframes djapp-blink{50%{opacity:.3}}',
      '#djapp-rec-time{font-variant-numeric:tabular-nums;min-width:44px;text-align:right}',
      '@media (max-width: 600px){',
        '#djapp-rec-ui{',
          'bottom:calc(60px + env(safe-area-inset-bottom));',
          'right:calc(10px + env(safe-area-inset-right));',
          'padding:7px 10px;gap:7px;',
          'font-size:11px;',
          'border-radius:22px;',
        '}',
        '#djapp-rec-ui button{',
          'padding:9px 14px;font-size:12px;',
          'min-height:36px;min-width:70px;',
          'border-radius:18px;',
        '}',
        '#djapp-rec-dot{width:10px;height:10px}',
        '#djapp-rec-time{min-width:40px;font-size:11px}',
      '}',
      '@media (max-width: 360px){',
        '#djapp-rec-time{display:none}',
      '}'
    ].join('');
    document.head.appendChild(style);

    var wrap = document.createElement('div');
    wrap.id = 'djapp-rec-ui';
    wrap.innerHTML =
      '<span id="djapp-rec-dot"></span>' +
      '<span id="djapp-rec-time">00:00</span>' +
      '<button id="djapp-rec-btn" title="Registra il mix in WAV">● REC</button>';
    document.body.appendChild(wrap);
    state.ui = {
      wrap: wrap,
      btn: wrap.querySelector('#djapp-rec-btn'),
      time: wrap.querySelector('#djapp-rec-time')
    };
    state.ui.btn.addEventListener('click', toggle);
  }

  function toggle() {
    if (!state.worklet) { alert('Recorder non ancora pronto. Fai partire un brano e riprova.'); return; }
    if (state.recording) stop(); else start();
  }

  function start() {
    if (state.ctx.state === 'suspended') {
      state.ctx.resume(); // iOS: sblocca ctx sul gesto utente
    }
    state.buffers = [];
    state.totalSamples = 0;
    state.recording = true;
    state.worklet.port.postMessage({ cmd: 'start' });
    state.ui.wrap.classList.add('on');
    state.ui.btn.classList.add('on');
    state.ui.btn.textContent = '■ STOP';
  }

  function stop() {
    state.recording = false;
    state.worklet.port.postMessage({ cmd: 'stop' });
    state.ui.wrap.classList.remove('on');
    state.ui.btn.classList.remove('on');
    state.ui.btn.textContent = '● REC';

    if (state.buffers.length === 0) { alert('Nessun audio catturato.'); return; }

    var blob = encodeWAV(state.buffers, state.ctx.sampleRate);
    var url = URL.createObjectURL(blob);
    var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'djappR1-mix-' + ts + '.wav';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);

    state.buffers = [];
    state.totalSamples = 0;
    state.ui.time.textContent = '00:00';
  }

  function updateTime() {
    if (!state.ui || !state.recording) return;
    var sec = Math.floor(state.totalSamples / state.ctx.sampleRate);
    var m = String(Math.floor(sec / 60)).padStart(2, '0');
    var s = String(sec % 60).padStart(2, '0');
    state.ui.time.textContent = m + ':' + s;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      if (!state.ui) renderUI();
    });
  } else {
    renderUI();
  }
})();
