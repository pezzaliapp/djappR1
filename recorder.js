/*!
 * djappR1 Recorder v1.5 — MediaRecorder + conversione a WAV
 * Intercetta l'AudioContext dell'app, tap sul master, registrazione via
 * MediaStreamAudioDestinationNode + MediaRecorder. Al termine, decodifica
 * e ri-encode in WAV PCM16 stereo. Fallback al formato originale se la
 * conversione fallisce. Nessuna dipendenza.
 *
 * Changelog v1.5 (vs v1.4):
 *   • [iOS] Via ScriptProcessorNode, dentro MediaRecorder. Su iOS Safari
 *     onaudioprocess non si schedula mai in modo affidabile (confermato su
 *     hardware reale), mentre MediaRecorder è l'API che Apple supporta
 *     nativamente e funziona al primo colpo.
 *   • Conversione AAC→WAV post-registrazione via decodeAudioData:
 *     l'utente scarica comunque un .wav come prima.
 *   • Fallback automatico a .m4a se decodeAudioData fallisce.
 *   • Timer basato su Date.now() invece che samples contati (più affidabile
 *     con MediaRecorder che emette chunk asincroni).
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
  if (typeof MediaRecorder === 'undefined') {
    console.warn('[djappR1 Recorder] MediaRecorder non disponibile');
    return;
  }

  var TRUE_CONNECT = AudioNode.prototype.connect;

  var state = {
    ctx: null,
    tap: null,
    destStream: null,
    mediaRecorder: null,
    chunks: [],
    recording: false,
    startTs: 0,
    timerInterval: null,
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
    var tap = ctx.createGain();
    tap.gain.value = 1.0;
    tap.connect(ctx.destination); // diretto pre-patch
    state.tap = tap;

    AudioNode.prototype.connect = function (target) {
      if (target === ctx.destination && this !== tap) {
        arguments[0] = tap;
      }
      return TRUE_CONNECT.apply(this, arguments);
    };

    console.log('[djappR1 Recorder v1.5] Tap armato, MediaRecorder creato al primo REC');
    renderUI();
  }

  // -------- MIME type picker --------
  function pickMimeType() {
    var candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/aac'
    ];
    for (var i = 0; i < candidates.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
      } catch (e) {}
    }
    return ''; // browser default
  }

  function extensionFor(mimeType) {
    var m = (mimeType || '').toLowerCase();
    if (m.indexOf('webm') !== -1) return 'webm';
    if (m.indexOf('mp4') !== -1 || m.indexOf('aac') !== -1) return 'm4a';
    if (m.indexOf('ogg') !== -1) return 'ogg';
    return 'audio';
  }

  // -------- Setup MediaRecorder LAZY al primo REC (gesto-utente) --------
  function createRecorderIfNeeded() {
    if (state.mediaRecorder) return true;
    if (!state.ctx || !state.tap) return false;

    try {
      // MediaStreamAudioDestinationNode è un endpoint: tap → destStream.stream
      var dest = state.ctx.createMediaStreamDestination();
      state.tap.connect(dest);
      state.destStream = dest;

      var mime = pickMimeType();
      var opts = mime ? { mimeType: mime } : undefined;
      var rec = new MediaRecorder(dest.stream, opts);

      rec.ondataavailable = function (e) {
        if (e.data && e.data.size > 0) state.chunks.push(e.data);
      };
      rec.onstop = function () { finalize(); };
      rec.onerror = function (e) {
        console.error('[djappR1 Recorder] MediaRecorder error:', e);
        alert('Errore durante la registrazione: ' + (e.error && e.error.message ? e.error.message : 'ignoto'));
      };

      state.mediaRecorder = rec;
      console.log('[djappR1 Recorder v1.5] MediaRecorder creato, mimeType=' +
                  (rec.mimeType || '(default)') + ', ctx.state=' + state.ctx.state);
      return true;
    } catch (e) {
      alert('Errore creazione MediaRecorder: ' + (e.message || e));
      return false;
    }
  }

  // -------- Encoders --------
  // Da AudioBuffer → WAV PCM16 stereo
  function encodeWAVFromAudioBuffer(audioBuffer) {
    var numCh = Math.min(audioBuffer.numberOfChannels, 2);
    var sampleRate = audioBuffer.sampleRate;
    var total = audioBuffer.length;
    var c0 = audioBuffer.getChannelData(0);
    var c1 = numCh > 1 ? audioBuffer.getChannelData(1) : c0;

    var pcm = new Int16Array(total * 2);
    var off = 0;
    for (var k = 0; k < total; k++) {
      var s0 = c0[k] < -1 ? -1 : c0[k] > 1 ? 1 : c0[k];
      var s1 = c1[k] < -1 ? -1 : c1[k] > 1 ? 1 : c1[k];
      pcm[off++] = s0 < 0 ? s0 * 0x8000 : s0 * 0x7FFF;
      pcm[off++] = s1 < 0 ? s1 * 0x8000 : s1 * 0x7FFF;
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

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  // Finalize: combina chunks, decodifica, ri-encoda in WAV, scarica
  function finalize() {
    var wasOn = state.chunks.length > 0;
    state.ui.btn.disabled = true;
    state.ui.btn.textContent = '...';

    if (!wasOn) {
      state.ui.btn.disabled = false;
      state.ui.btn.textContent = '● REC';
      state.ui.time.textContent = '00:00';
      alert('Nessun audio catturato.');
      return;
    }

    var mime = (state.mediaRecorder && state.mediaRecorder.mimeType) || 'audio/mp4';
    var blob = new Blob(state.chunks, { type: mime });
    state.chunks = [];
    var ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    // Prova a convertire a WAV
    blob.arrayBuffer()
      .then(function (ab) {
        // decodeAudioData richiede un AudioContext; usiamo quello esistente.
        return new Promise(function (resolve, reject) {
          state.ctx.decodeAudioData(
            ab.slice(0), // slice per sicurezza: alcune implementazioni consumano l'AB
            function (audioBuf) { resolve(audioBuf); },
            function (err) { reject(err || new Error('decodeAudioData failed')); }
          );
        });
      })
      .then(function (audioBuf) {
        var wav = encodeWAVFromAudioBuffer(audioBuf);
        downloadBlob(wav, 'djappR1-mix-' + ts + '.wav');
        console.log('[djappR1 Recorder v1.5] WAV scaricato, durata=' +
                    audioBuf.duration.toFixed(2) + 's');
      })
      .catch(function (err) {
        // Fallback: scarica nel formato originale
        console.warn('[djappR1 Recorder v1.5] conversione WAV fallita, fallback:', err);
        var ext = extensionFor(mime);
        downloadBlob(blob, 'djappR1-mix-' + ts + '.' + ext);
      })
      .finally(function () {
        state.ui.btn.disabled = false;
        state.ui.btn.textContent = '● REC';
        state.ui.time.textContent = '00:00';
      });
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
      '#djapp-rec-ui button:disabled{opacity:.6}',
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
    if (state.ctx.state === 'suspended') state.ctx.resume();
    if (!createRecorderIfNeeded()) return;

    state.chunks = [];
    state.recording = true;
    state.startTs = Date.now();

    try {
      state.mediaRecorder.start(1000); // emette un chunk ogni secondo
    } catch (e) {
      alert('Impossibile avviare MediaRecorder: ' + (e.message || e));
      state.recording = false;
      return;
    }

    state.ui.wrap.classList.add('on');
    state.ui.btn.classList.add('on');
    state.ui.btn.textContent = '■ STOP';

    // Timer wall-clock (più affidabile dei chunk MediaRecorder)
    if (state.timerInterval) clearInterval(state.timerInterval);
    state.timerInterval = setInterval(function () {
      if (!state.recording) return;
      var sec = Math.floor((Date.now() - state.startTs) / 1000);
      var m = String(Math.floor(sec / 60)).padStart(2, '0');
      var s = String(sec % 60).padStart(2, '0');
      state.ui.time.textContent = m + ':' + s;
    }, 250);
  }

  function stop() {
    if (!state.recording) return;
    state.recording = false;

    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }

    state.ui.wrap.classList.remove('on');
    state.ui.btn.classList.remove('on');
    // finalize() aggiorna testo e disabled

    try {
      if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
        state.mediaRecorder.stop(); // triggera onstop → finalize()
      } else {
        finalize();
      }
    } catch (e) {
      console.error('[djappR1 Recorder v1.5] stop error:', e);
      finalize();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      if (!state.ui) renderUI();
    });
  } else {
    renderUI();
  }
})();
