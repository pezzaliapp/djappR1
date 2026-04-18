/*!
 * djappR1 Recorder v1.4 — ScriptProcessor lazy (iOS safe)
 * Intercetta l'AudioContext dell'app, tap sul master, registrazione via
 * ScriptProcessorNode creato LAZY al primo click REC. Nessuna dipendenza.
 *
 * Changelog v1.4 (vs v1.3):
 *   • [iOS] ScriptProcessorNode creato on-demand al primo click REC, non più
 *     dentro il constructor di PatchedCtx. Motivazione: iOS Safari NON
 *     schedula onaudioprocess per SPN creati quando l'AudioContext è
 *     "suspended" (prima di qualunque gesto utente). Su Mac è tollerato, su
 *     iOS no. Creandolo nel gesto-utente di REC il context è già running e
 *     il node viene correttamente schedulato.
 *   • Connessione spn→destination DIRETTA (niente gain a zero intermedio):
 *     alcuni iOS non schedulano SPN connessi indirettamente.
 *   • Output silence esplicita scritta a ogni callback: iOS vuole che il
 *     SPN "produca" qualcosa nell'output anche se inudibile.
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

  // Salva il VERO connect PRIMA di qualunque patch
  var TRUE_CONNECT = AudioNode.prototype.connect;

  var state = {
    ctx: null,
    tap: null,
    spn: null,
    recording: false,
    buffers: [],
    totalSamples: 0,
    ui: null
  };

  // -------- Monkey-patch AudioContext --------
  class PatchedCtx extends OrigCtx {
    constructor() {
      super(...arguments);
      if (!state.ctx) {
        state.ctx = this;
        try { setupTap(this); } catch (e) { console.error('[djappR1 Recorder] setup:', e); }
      }
    }
  }
  window.AudioContext = PatchedCtx;
  window.webkitAudioContext = PatchedCtx;

  function setupTap(ctx) {
    // Tap gain: riceve tutto l'audio dell'app via monkey-patch su connect()
    var tap = ctx.createGain();
    tap.gain.value = 1.0;
    tap.connect(ctx.destination); // PRE-PATCH, diretto
    state.tap = tap;

    // Ridirigi ogni connect(ctx.destination) verso tap (tranne tap stesso)
    AudioNode.prototype.connect = function (target) {
      if (target === ctx.destination && this !== tap) {
        arguments[0] = tap;
      }
      return TRUE_CONNECT.apply(this, arguments);
    };

    console.log('[djappR1 Recorder v1.4] Tap armato, SPN sarà creato al primo REC');
    renderUI(); // UI subito visibile, il pulsante è già cliccabile
  }

  // -------- SPN creato LAZY al primo click REC (gesto-utente, ctx running) --------
  function createSpnIfNeeded() {
    if (state.spn) return true;
    if (!state.ctx || !state.tap) return false;

    try {
      var spn = state.ctx.createScriptProcessor(4096, 2, 2);

      // Collega tap → SPN (per catturare) e SPN → destination DIRETTAMENTE.
      // TRUE_CONNECT evita che la patch reindirizzi spn→destination su tap
      // (che creerebbe loop tap→spn→tap).
      state.tap.connect(spn);
      TRUE_CONNECT.call(spn, state.ctx.destination);

      spn.onaudioprocess = function (e) {
        // iOS: scrivi sempre silence all'output, altrimenti alcuni iOS
        // considerano il nodo "inattivo" e smettono di chiamarci.
        var outL = e.outputBuffer.getChannelData(0);
        var outR = e.outputBuffer.getChannelData(1);
        outL.fill(0);
        outR.fill(0);

        if (!state.recording) return;

        var input = e.inputBuffer;
        var src0 = input.getChannelData(0);
        var src1 = input.numberOfChannels > 1 ? input.getChannelData(1) : src0;
        // getChannelData riusa il buffer sottostante → copia necessaria
        var c0 = new Float32Array(src0.length);
        var c1 = new Float32Array(src1.length);
        c0.set(src0);
        c1.set(src1);
        state.buffers.push({ c0: c0, c1: c1 });
        state.totalSamples += c0.length;
        updateTime();
      };

      state.spn = spn;
      console.log('[djappR1 Recorder v1.4] SPN creato in user-gesture, sampleRate=' +
                  state.ctx.sampleRate + ', ctx.state=' + state.ctx.state);
      return true;
    } catch (e) {
      alert('Errore creazione recorder: ' + (e.message || e));
      return false;
    }
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
    if (!state.ctx) { alert('Recorder non pronto. Ricarica la pagina.'); return; }
    if (state.recording) stop(); else start();
  }

  function start() {
    // Sblocca il context se suspended (gesto utente attivo qui)
    if (state.ctx.state === 'suspended') state.ctx.resume();

    // Crea SPN LAZY — deve accadere durante gesto utente con ctx running
    if (!createSpnIfNeeded()) return;

    state.buffers = [];
    state.totalSamples = 0;
    state.recording = true;
    state.ui.wrap.classList.add('on');
    state.ui.btn.classList.add('on');
    state.ui.btn.textContent = '■ STOP';
  }

  function stop() {
    state.recording = false;
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
