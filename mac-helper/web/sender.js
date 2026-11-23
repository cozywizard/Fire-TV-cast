/* Fire TV Cast – sender page, served by the helper on your Mac (open in Chrome). */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);

  const QUALITY = {
    720: { w: 1280, h: 720, bitrate: 5_000_000 },
    1080: { w: 1920, h: 1080, bitrate: 10_000_000 },
    1440: { w: 2560, h: 1440, bitrate: 16_000_000 },
    2160: { w: 3840, h: 2160, bitrate: 25_000_000 },
  };
  const CODEC_MIME = { h264: 'video/h264', vp8: 'video/vp8', vp9: 'video/vp9' };

  let ws = null;
  let wsReplaced = false;
  let tvReady = false;
  let pc = null;
  let session = null; // { kind: 'screen'|'file'|'link', stream?, url?, cleanup: [] }
  let queue = Promise.resolve();
  let statsTimer = null;
  let lastStats = null;
  let reconnectDelay = 1000;
  let tvCaps = null; // what the TV's browser reported it can do
  let pageVersion = null; // helper version this page was loaded from

  // ---------- Settings ----------

  const settingIds = ['optRes', 'optFps', 'optHint', 'optCodec', 'optLocalSound', 'optAudioMethod'];
  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('ftvcast-settings') || '{}');
      for (const id of settingIds) {
        if (saved[id] === undefined) continue;
        const el = document.getElementById(id);
        if (el.type === 'checkbox') el.checked = !!saved[id]; else el.value = saved[id];
      }
    } catch (e) { /* storage unavailable */ }
  }
  function saveSettings() {
    try {
      const out = {};
      for (const id of settingIds) {
        const el = document.getElementById(id);
        out[id] = el.type === 'checkbox' ? el.checked : el.value;
      }
      localStorage.setItem('ftvcast-settings', JSON.stringify(out));
    } catch (e) { /* ignore */ }
  }
  function settings() {
    const res = $('#optRes').value;
    return {
      q: QUALITY[res] || QUALITY[1080],
      fps: parseInt($('#optFps').value, 10) || 30,
      hint: $('#optHint').value,
      codec: $('#optCodec').value,
    };
  }
  for (const id of settingIds) {
    document.getElementById(id).addEventListener('change', () => {
      saveSettings();
      if (id === 'optAudioMethod') sendAudioMethod();
      else if (id === 'optLocalSound' && session && session.setLocalSound) session.setLocalSound($('#optLocalSound').checked);
      else if (pc) applyEncoding().catch(() => {});
    });
  }

  // ---------- Signaling ----------

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    wsReplaced = false;
    setPill('warn', 'Connecting to TV…');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws?role=sender`);
    ws.onopen = () => { reconnectDelay = 1000; };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      queue = queue.then(() => handle(msg)).catch((err) => console.error(err));
    };
    ws.onclose = () => {
      tvReady = false;
      if (wsReplaced) {
        setPill('warn', 'Another device is casting');
        return;
      }
      setPill('bad', 'The Fire TV Cast helper has stopped – open it again');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    };
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
  setInterval(() => send({ type: 'ping' }), 15000);

  async function handle(msg) {
    switch (msg.type) {
      case 'hello':
        // After an update the helper restarts with a new version: load the new page.
        if (msg.version) {
          if (!pageVersion) pageVersion = msg.version;
          else if (msg.version !== pageVersion) { location.reload(); return; }
        }
        // falls through
      case 'receiver-ready':
        tvReady = msg.type === 'receiver-ready' || !!msg.receiverReady;
        updatePill();
        if (tvReady) sendAudioMethod();
        if (tvReady && session) await resume();
        break;
      case 'receiver-left':
        tvReady = false;
        tvCaps = null;
        updatePill();
        if (session) {
          closePc();
          setCastState('The TV page was closed – open it again in Silk on the TV to continue.');
        }
        break;
      case 'tv-audio':
        showTvAudio(msg);
        break;
      case 'tv-tone':
        $('#toneResult').textContent = msg.webaudio
          ? 'Tone sent – did you hear a beep on the TV?'
          : `The TV page couldn't play a tone (audio engine: ${msg.ctx}). Press the middle button on the remote and try again.`;
        break;
      case 'tv-info':
        tvCaps = msg;
        showTvInfo();
        break;
      case 'answer':
        if (pc) await acceptAnswer(msg.sdp);
        break;
      case 'candidate':
        if (pc && msg.candidate) {
          try { await pc.addIceCandidate(msg.candidate); } catch (e) { console.warn('candidate', e); }
        }
        break;
      case 'receiver-stopped':
        endSession({ notifyTv: false, message: 'Stopped from the TV remote.' });
        break;
      case 'receiver-error':
        setCastState('The TV reported an error: ' + msg.message);
        break;
      case 'playback':
        onPlayback(msg);
        break;
      case 'replaced':
        wsReplaced = true;
        endSession({ notifyTv: false, message: 'Another device started casting to this TV.' });
        break;
      case 'error':
        showWarning(msg.message);
        break;
    }
  }

  function updatePill() {
    if (!ws || ws.readyState !== 1) return;
    if (tvReady) setPill('ok', 'TV connected');
    else setPill('warn', 'Waiting for the TV');
    $('#tvSetup').classList.toggle('hidden', tvReady);
    if (!tvReady) $('#tvInfoLine').classList.add('hidden');
  }
  function setPill(kind, text) {
    const el = $('#tvStatus');
    if (!el) return;
    el.className = 'pill ' + kind;
    el.querySelector('span').textContent = text;
  }

  // ---------- Starting casts ----------

  async function startScreen() {
    const { q, fps } = settings();
    const video = { width: { max: q.w }, height: { max: q.h }, frameRate: { ideal: fps, max: fps } };
    const audio = {
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      suppressLocalAudioPlayback: true,
    };
    const extras = { systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include' };
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video, audio, ...extras });
    } catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'AbortError') return; // user cancelled
      try {
        // Browsers without display-audio support (e.g. Safari) reject the audio request.
        stream = await navigator.mediaDevices.getDisplayMedia({ video });
      } catch (e2) {
        if (e2.name !== 'NotAllowedError') showWarning('Screen sharing failed: ' + e2.message);
        return;
      }
    }
    const vt = stream.getVideoTracks()[0];
    const label = vt && vt.label ? vt.label : 'your screen';
    const hasAudio = stream.getAudioTracks().length > 0;
    beginSession({ kind: 'screen', stream, title: 'Mirroring ' + friendlySurface(vt) });
    if (vt) vt.addEventListener('ended', () => endSession({ message: 'Screen sharing stopped.' }));
    if (!hasAudio) showWarning('No audio is being shared. To cast sound, share a Chrome tab with “Also share tab audio”, or the entire screen with “Also share system audio”.');
    console.log('sharing', label);
  }

  function friendlySurface(track) {
    const s = track && track.getSettings ? track.getSettings().displaySurface : '';
    return s === 'browser' ? 'a tab' : s === 'window' ? 'a window' : 'your screen';
  }

  async function startFile(file) {
    if (!file) return;
    // A fresh <video> each time: createMediaElementSource can only be used once per element.
    const old = $('#localVideo');
    const v = old.cloneNode(false);
    old.replaceWith(v);
    const url = URL.createObjectURL(file);
    v.src = url;

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaElementSource(v);
    const dest = ctx.createMediaStreamDestination();
    source.connect(dest);
    const localGain = ctx.createGain();
    localGain.gain.value = $('#optLocalSound').checked ? 1 : 0;
    source.connect(localGain).connect(ctx.destination);

    const cleanup = [() => { v.pause(); v.removeAttribute('src'); v.load(); }, () => URL.revokeObjectURL(url), () => ctx.close()];

    try {
      await new Promise((resolve, reject) => {
        v.addEventListener('loadedmetadata', resolve, { once: true });
        v.addEventListener('error', () => reject(new Error('Chrome can’t play this file. Try an MP4 (H.264/HEVC + AAC) or WebM file.')), { once: true });
      });
      await ctx.resume();
      await v.play();
    } catch (e) {
      cleanup.forEach((f) => { try { f(); } catch {} });
      showWarning(e.message || String(e));
      return;
    }

    const captured = (v.captureStream || v.mozCaptureStream).call(v);
    let videoTrack = captured.getVideoTracks()[0];
    if (!videoTrack && v.videoWidth) {
      await new Promise((r) => setTimeout(r, 300));
      videoTrack = captured.getVideoTracks()[0];
    }
    const tracks = [videoTrack, dest.stream.getAudioTracks()[0]].filter(Boolean);
    const stream = new MediaStream(tracks);
    cleanup.push(() => captured.getTracks().forEach((t) => t.stop()));

    beginSession({
      kind: 'file', stream, title: 'Playing ' + file.name, cleanup, video: v,
      setLocalSound: (on) => { localGain.gain.value = on ? 1 : 0; },
    });
    v.addEventListener('ended', () => setCastState('Finished. Press play to watch again, or stop casting.'));
  }

  function startLink(url) {
    beginSession({ kind: 'link', url, title: 'Playing a link on the TV' });
  }

  function beginSession(s) {
    if (session) endSession({ notifyTv: true, quiet: true });
    session = Object.assign({ cleanup: [] }, s);
    hideWarning();
    connect();
    $('#choose').classList.add('hidden');
    $('#casting').classList.remove('hidden');
    $('#castTitle').textContent = s.title;
    $('#filePanel').classList.toggle('hidden', s.kind !== 'file');
    $('#linkPanel').classList.toggle('hidden', s.kind !== 'link');
    $('#senderStats').textContent = '';
    $('#tvAudio').textContent = 'TV sound: checking…';
    $('#toneResult').textContent = '';
    document.querySelector('.tv-sound').classList.toggle('hidden', s.kind === 'link');
    if (tvReady) resume();
    else setCastState('Waiting for the TV… open the address shown above in Silk on your Fire TV.');
  }

  async function resume() {
    if (!session) return;
    if (session.kind === 'link') {
      send({ type: 'play-url', url: session.url });
      setCastState('Sent to TV. Loading…');
    } else {
      await negotiate();
    }
  }

  function endSession({ notifyTv = true, message = '', quiet = false } = {}) {
    if (!session) return;
    if (notifyTv) send({ type: 'stop' });
    closePc();
    const s = session;
    session = null;
    if (s.stream) s.stream.getTracks().forEach((t) => t.stop());
    for (const f of s.cleanup) { try { f(); } catch {} }
    if (quiet) return;
    $('#casting').classList.add('hidden');
    $('#choose').classList.remove('hidden');
    $('#linkForm').classList.add('hidden');
    if (message) showWarning(message, true);
  }

  // ---------- WebRTC ----------

  async function negotiate() {
    closePc();
    const s = session;
    const { codec, hint } = settings();
    const conn = new RTCPeerConnection({ iceServers: [] });
    pc = conn;

    conn.onicecandidate = (e) => {
      if (e.candidate && conn === pc) send({ type: 'candidate', candidate: e.candidate.toJSON() });
    };
    conn.onconnectionstatechange = () => {
      if (conn !== pc) return;
      const st = conn.connectionState;
      if (st === 'connected') setCastState('● Live on your TV');
      else if (st === 'connecting') setCastState('Connecting to the TV…');
      else if (st === 'disconnected') setCastState('Connection interrupted – retrying…');
      else if (st === 'failed') setCastState('Could not connect to the TV. Make sure your Mac and the Fire TV are on the same network, then try again.');
    };

    for (const track of s.stream.getTracks()) {
      if (track.kind === 'video') {
        try { track.contentHint = s.kind === 'file' ? 'motion' : hint; } catch {}
      }
      const tr = conn.addTransceiver(track, { direction: 'sendonly', streams: [s.stream] });
      if (track.kind === 'video') preferCodec(tr, effectiveCodec(codec));
    }

    setCastState('Connecting to the TV…');
    const offer = await conn.createOffer();
    await conn.setLocalDescription(offer);
    send({ type: 'offer', sdp: conn.localDescription.sdp });
    startStats();
  }

  // If the TV told us it can't decode the chosen codec, fall back to one it can.
  function effectiveCodec(pref) {
    const tv = tvCaps && Array.isArray(tvCaps.codecs) ? tvCaps.codecs : null;
    if (!tv || !tv.length || pref === 'auto') return pref;
    if (CODEC_MIME[pref] && tv.includes(CODEC_MIME[pref])) return pref;
    for (const c of ['h264', 'vp8', 'vp9']) if (tv.includes(CODEC_MIME[c])) return c;
    return 'auto';
  }

  function sendAudioMethod() {
    send({ type: 'audio-method', method: $('#optAudioMethod').value });
  }

  function showTvAudio(m) {
    const lvl = (x) => (typeof x === 'number' ? x.toFixed(3) : 'n/a');
    let text;
    if (!m.tracks) {
      text = 'TV sound: the Mac isn’t sending any sound. Stop casting and start again – when Chrome asks what to share, turn on “Also share tab audio” (for a tab) or “Also share system audio” (for the entire screen).';
    } else if (!m.bytes) {
      text = 'TV sound: the TV isn’t receiving any sound yet.';
    } else {
      const playing = m.path === 'webaudio'
        ? `method A (output level ${lvl(m.webLevel)}, engine ${m.ctx})`
        : m.path === 'element'
          ? `method B (${m.videoMuted ? 'muted' : 'unmuted'}${m.videoPaused ? ', paused' : ''})`
          : 'not playing yet';
      text = `TV sound: receiving ✓${m.path === 'element' ? ` (level ${lvl(m.rtpLevel)})` : ''} · ${playing}` +
        (m.prompt ? ' · waiting for a button press on the remote' : '');
    }
    $('#tvAudio').textContent = text;
  }

  function showTvInfo() {
    const el = $('#tvInfoLine');
    if (!tvCaps) { el.classList.add('hidden'); return; }
    const names = (tvCaps.codecs || []).map((c) => c.replace('video/', '').toUpperCase());
    if (!tvCaps.webrtc) {
      showWarning('Your TV’s browser can’t receive live video (it has no WebRTC support), so mirroring and video files won’t work on it. “Play a link” may still work.');
    }
    el.textContent = `TV browser: WebRTC ${tvCaps.webrtc ? '✓' : '✗'}` +
      (names.length ? ` · can decode ${names.join(', ')}` : '') +
      (tvCaps.screen ? ` · screen ${tvCaps.screen}` : '') +
      (tvCaps.started ? '' : ' · press OK on the remote to finish setup');
    el.classList.remove('hidden');
  }

  function preferCodec(transceiver, pref) {
    const mime = CODEC_MIME[pref];
    if (!mime || !transceiver.setCodecPreferences || !window.RTCRtpReceiver || !RTCRtpReceiver.getCapabilities) return;
    const caps = RTCRtpReceiver.getCapabilities('video');
    if (!caps) return;
    const first = caps.codecs.filter((c) => c.mimeType.toLowerCase() === mime);
    if (!first.length) return;
    const rest = caps.codecs.filter((c) => c.mimeType.toLowerCase() !== mime);
    try { transceiver.setCodecPreferences([...first, ...rest]); } catch (e) { console.warn('codec pref', e); }
  }

  async function acceptAnswer(sdp) {
    const conn = pc;
    const { q } = settings();
    try {
      await conn.setRemoteDescription({ type: 'answer', sdp: boostStartBitrate(sdp, q.bitrate) });
    } catch (e) {
      console.warn('munged answer rejected, using original', e);
      await conn.setRemoteDescription({ type: 'answer', sdp });
    }
    await applyEncoding();
  }

  // Chrome starts WebRTC video at ~300 kbps and ramps up; on a LAN we can start much higher.
  function boostStartBitrate(sdp, bitrate) {
    const kbps = Math.round(bitrate / 1000);
    const lines = sdp.split('\r\n');
    let inVideo = false;
    const videoPts = new Set();
    for (const l of lines) {
      if (l.startsWith('m=')) inVideo = l.startsWith('m=video');
      const m = inVideo && /^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\//i.exec(l);
      if (m) videoPts.add(m[1]);
    }
    return lines.map((l) => {
      const m = /^a=fmtp:(\d+) /.exec(l);
      if (m && videoPts.has(m[1]) && !l.includes('x-google-')) {
        return `${l};x-google-start-bitrate=${Math.round(kbps / 2)};x-google-max-bitrate=${kbps}`;
      }
      return l;
    }).join('\r\n');
  }

  async function applyEncoding() {
    if (!pc || !session) return;
    const { q, fps, hint } = settings();
    for (const sender of pc.getSenders()) {
      if (!sender.track) continue;
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      const enc = p.encodings[0];
      if (sender.track.kind === 'video') {
        const st = sender.track.getSettings();
        const w = st.width || (session.video && session.video.videoWidth) || 0;
        const h = st.height || (session.video && session.video.videoHeight) || 0;
        enc.maxBitrate = Math.round(q.bitrate * (fps > 30 ? 1.5 : 1));
        enc.maxFramerate = session.kind === 'file' ? 60 : fps;
        enc.scaleResolutionDownBy = Math.max(1, w / q.w, h / q.h);
        enc.priority = 'high';
        enc.networkPriority = 'high';
        if (session.kind !== 'file') {
          p.degradationPreference = hint === 'detail' ? 'maintain-resolution' : 'maintain-framerate';
        }
      } else {
        enc.maxBitrate = 256_000;
      }
      try {
        await sender.setParameters(p);
      } catch (e) {
        delete p.degradationPreference;
        try { await sender.setParameters(p); } catch (e2) { console.warn('setParameters', e2); }
      }
    }
  }

  function closePc() {
    stopStats();
    if (pc) {
      const old = pc;
      pc = null;
      try { old.close(); } catch {}
    }
  }

  // ---------- Stats ----------

  function startStats() {
    stopStats();
    statsTimer = setInterval(updateStats, 1000);
  }
  function stopStats() {
    clearInterval(statsTimer);
    statsTimer = null;
    lastStats = null;
  }
  async function updateStats() {
    if (!pc) return;
    const report = await pc.getStats();
    let v = null, pair = null;
    const codecs = {};
    report.forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video') v = s;
      if (s.type === 'codec') codecs[s.id] = s;
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
    });
    if (!v) return;
    const now = performance.now();
    let mbps = 0;
    if (lastStats) mbps = ((v.bytesSent - lastStats.bytes) * 8) / ((now - lastStats.t) * 1000);
    lastStats = { bytes: v.bytesSent, t: now };
    const codec = v.codecId && codecs[v.codecId] ? codecs[v.codecId].mimeType.replace('video/', '') : '…';
    const parts = [
      `${v.frameWidth || '?'}×${v.frameHeight || '?'}`,
      `${v.framesPerSecond != null ? Math.round(v.framesPerSecond) : '?'} fps`,
      `${mbps.toFixed(1)} Mbps`,
      `${codec}${v.encoderImplementation ? ' (' + v.encoderImplementation + ')' : ''}`,
    ];
    if (pair && pair.currentRoundTripTime != null) parts.push(`${Math.round(pair.currentRoundTripTime * 1000)} ms RTT`);
    if (v.qualityLimitationReason && v.qualityLimitationReason !== 'none') parts.push(`limited by ${v.qualityLimitationReason}`);
    $('#senderStats').textContent = parts.join('  ·  ');
  }

  // ---------- Link playback UI ----------

  function onPlayback(msg) {
    if (!session || session.kind !== 'link') return;
    if (msg.state === 'error') {
      endSession({ notifyTv: false, message: msg.message || 'The TV could not play this link.' });
      return;
    }
    const fmt = (t) => {
      t = Math.max(0, Math.floor(t || 0));
      const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = String(t % 60).padStart(2, '0');
      return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
    };
    $('#linkTime').textContent = `${fmt(msg.currentTime)} / ${msg.duration ? fmt(msg.duration) : 'live'}`;
    $('#linkBar').style.width = msg.duration ? `${(100 * msg.currentTime) / msg.duration}%` : '0';
    $('#linkToggle').textContent = msg.state === 'playing' ? 'Pause' : 'Play';
    setCastState(msg.state === 'ended' ? 'Finished' : msg.state === 'playing' ? '● Playing on your TV' : 'Paused');
  }

  $('#linkPanel').addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    if (act === 'toggle') send({ type: 'control', action: 'toggle' });
    if (act === 'back') send({ type: 'control', action: 'seek', delta: -10 });
    if (act === 'fwd') send({ type: 'control', action: 'seek', delta: 30 });
  });

  // ---------- UI wiring ----------

  function setCastState(text) { $('#castState').textContent = text; }
  function showWarning(text, info) {
    const el = $('#warning');
    el.textContent = text;
    el.classList.remove('hidden');
    el.dataset.info = info ? '1' : '';
  }
  function hideWarning() { $('#warning').classList.add('hidden'); }

  $('#btnScreen').addEventListener('click', () => { hideWarning(); startScreen(); });
  $('#btnFile').addEventListener('click', () => { hideWarning(); $('#fileInput').value = ''; $('#fileInput').click(); });
  $('#fileInput').addEventListener('change', (e) => startFile(e.target.files[0]));
  $('#btnLink').addEventListener('click', () => {
    hideWarning();
    $('#linkForm').classList.toggle('hidden');
    $('#linkInput').focus();
  });
  $('#linkForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#linkInput').value.trim();
    if (url) startLink(url);
  });
  let soundCheckBaseline = null, soundCheckTimer = null;
  $('#btnSoundCheck').addEventListener('click', async () => {
    if (!tvReady) { showWarning('Open the TV page in Silk first, then run the sound check.'); return; }
    try { soundCheckBaseline = ((await (await fetch('/api/info', { cache: 'no-store' })).json()).soundCheck || {}).at || null; } catch {}
    send({ type: 'soundcheck' });
    const el = $('#soundCheckLog');
    el.classList.remove('hidden');
    el.textContent = 'The sound check is now open on the TV. Press the middle button on the remote to start it, and note which numbered sounds you hear. The results will appear here.';
    clearInterval(soundCheckTimer);
    soundCheckTimer = setInterval(async () => {
      try {
        const sc = (await (await fetch('/api/info', { cache: 'no-store' })).json()).soundCheck;
        if (sc && sc.at !== soundCheckBaseline) {
          soundCheckBaseline = sc.at;
          el.textContent = `TV sound check results (${sc.at}):\n` + (sc.results || []).join('\n') +
            '\n\nTell Claude which numbers you heard, and copy this text too.';
        }
      } catch {}
    }, 2000);
  });

  $('#btnTone').addEventListener('click', () => {
    $('#toneResult').textContent = 'Sending…';
    send({ type: 'test-tone' });
  });
  $('#btnStop').addEventListener('click', () => endSession({ message: '' }));
  window.addEventListener('beforeunload', () => { if (session) send({ type: 'stop' }); });

  function checkSupport() {
    const problems = [];
    if (!window.isSecureContext) {
      problems.push('Open this page on the Mac as http://localhost – screen sharing is blocked on other addresses.');
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      $('#btnScreen').disabled = true;
      problems.push('This browser can’t share its screen here. Use Google Chrome on your Mac.');
    }
    if (!HTMLMediaElement.prototype.captureStream && !HTMLMediaElement.prototype.mozCaptureStream) {
      $('#btnFile').disabled = true;
      problems.push('Playing video files needs Google Chrome (Safari doesn’t support it).');
    }
    if (!window.RTCPeerConnection) {
      $('#btnScreen').disabled = true;
      $('#btnFile').disabled = true;
      problems.push('This browser doesn’t support WebRTC.');
    }
    if (problems.length) showWarning(problems.join(' '));
  }

  async function loadInfo() {
    try {
      const info = await (await fetch('/api/info', { cache: 'no-store' })).json();
      const box = $('#tvUrls');
      box.innerHTML = '';
      if (!info.ips || !info.ips.length) {
        box.innerHTML = '<span class="tv-url secondary">This Mac isn’t on a network. Connect to Wi‑Fi and reload this page.</span>';
      }
      (info.ips || []).forEach((ip, i) => {
        const el = document.createElement('span');
        el.className = 'tv-url' + (i ? ' secondary' : '');
        el.textContent = 'http://' + ip + (info.port === 80 ? '' : ':' + info.port);
        box.appendChild(el);
      });
      $('#helperVersion').textContent = 'Helper v' + info.version;
      showUpdate(info.update);
    } catch (e) { /* helper not reachable; the pill says so */ }
  }
  // ---------- Updates ----------

  function showUpdate(u) {
    const box = $('#updateBox');
    if (!u || u.status === 'idle') { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const text = $('#updateText');
    const btn = $('#btnUpdate');
    btn.classList.add('hidden');
    box.classList.toggle('update-ready', u.status === 'ready');
    switch (u.status) {
      case 'ready':
        text.textContent = `Update v${u.latest} is ready. It installs automatically next time you open Fire TV Cast.`;
        btn.textContent = 'Restart to update now';
        btn.dataset.action = 'apply';
        btn.classList.remove('hidden');
        break;
      case 'downloading':
        text.textContent = `Downloading update v${u.latest}…`;
        break;
      case 'checking':
        text.textContent = 'Checking for updates…';
        break;
      case 'up-to-date':
        text.textContent = 'Fire TV Cast is up to date.';
        btn.textContent = 'Check now';
        btn.dataset.action = 'check';
        btn.classList.remove('hidden');
        break;
      case 'error':
        text.textContent = u.message;
        btn.textContent = 'Try again';
        btn.dataset.action = 'check';
        btn.classList.remove('hidden');
        break;
      case 'disabled':
        text.textContent = u.message;
        break;
      default:
        text.textContent = '';
    }
  }

  async function refreshUpdate() {
    try { showUpdate((await (await fetch('/api/info', { cache: 'no-store' })).json()).update); } catch {}
  }

  $('#btnUpdate').addEventListener('click', async () => {
    const btn = $('#btnUpdate');
    if (btn.dataset.action === 'check') {
      await fetch('/api/update/check', { method: 'POST' }).catch(() => {});
      $('#updateText').textContent = 'Checking for updates…';
      btn.classList.add('hidden');
      setTimeout(refreshUpdate, 2500);
      setTimeout(refreshUpdate, 8000);
      return;
    }
    if (session && !confirm('Updating restarts Fire TV Cast and stops the current cast. Continue?')) return;
    btn.classList.add('hidden');
    $('#updateText').textContent = 'Installing the update and restarting… this page will reload in a few seconds.';
    try {
      const r = await fetch('/api/update/apply', { method: 'POST' });
      if (!r.ok) { $('#updateText').textContent = await r.text(); return; }
    } catch { /* the helper is restarting */ }
    if (session) endSession({ notifyTv: true, quiet: true });
    // The reconnect loop sees the new version and reloads the page.
  });

  $('#btnQuit').addEventListener('click', async () => {
    if (session) endSession({ message: '' });
    wsReplaced = true; // stop reconnecting
    try { ws && ws.close(); } catch {}
    try { await fetch('/api/quit', { method: 'POST' }); } catch {}
    document.body.innerHTML = '<main><h1>Fire TV Cast helper stopped</h1><p class="muted">Open the Fire TV Cast app again whenever you want to cast.</p></main>';
  });

  loadSettings();
  checkSupport();
  loadInfo();
  setInterval(() => { if (!tvReady) loadInfo(); }, 10000);
  setInterval(refreshUpdate, 60000);
  connect();
})();
