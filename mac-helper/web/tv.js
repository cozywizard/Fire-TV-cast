/* Fire TV Cast – TV player page. Open it in the Silk browser on your Fire TV. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var video = $('#video');

  var ws = null;
  var pc = null;
  var mode = 'idle';          // 'idle' | 'stream' | 'url'
  var queue = Promise.resolve();
  var disconnectTimer = null;
  var statsTimer = null;
  var statsVisible = false;
  var lastStats = null;
  var playbackTimer = null;
  var toastTimer = null;
  var replaced = false;
  var started = false;
  var audioCtx = null;   // unlocked by the Start button press
  var audioSrc = null;   // cast audio routed through audioCtx
  var hostName = '';

  // ---------- Signaling ----------

  function connect() {
    ws = new WebSocket('ws://' + location.host + '/ws?role=receiver');
    ws.onopen = function () {
      setStatus('Connected to ' + (hostName ? hostName : 'your Mac'), true);
      send(tvInfo());
    };
    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      // Process strictly in order (answer before candidates, etc).
      queue = queue.then(function () { return handle(msg); }).catch(function (err) {
        console.error('handle failed', err);
      });
    };
    ws.onclose = function () {
      if (replaced) { setStatus('This page was opened somewhere else.', false); return; }
      setStatus("Can't reach your Mac – is the Fire TV Cast helper running?", false);
      setTimeout(connect, 2000);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
  setInterval(function () { send({ type: 'ping' }); }, 15000);

  function handle(msg) {
    switch (msg.type) {
      case 'offer': return onOffer(msg);
      case 'candidate':
        if (pc && msg.candidate) {
          return pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(function (e) {
            console.warn('addIceCandidate', e);
          });
        }
        return;
      case 'sender-joined':
        toast('Connected to ' + (msg.name || 'your Mac'));
        return;
      case 'stop':
        stopAll();
        return;
      case 'sender-left':
        if (mode !== 'idle') { stopAll(); toast('Casting ended'); }
        return;
      case 'play-url': return playUrl(msg.url);
      case 'control': return control(msg);
      case 'replaced':
        // Another copy of this page took over; don't fight it.
        replaced = true;
        return;
    }
  }

  // ---------- WebRTC ----------

  function onOffer(msg) {
    closePc();
    stopUrl();
    showCast(true);

    var stream = new MediaStream();
    var conn = new RTCPeerConnection({ iceServers: [] });
    pc = conn;

    conn.ontrack = function (e) {
      if (conn !== pc) return;
      stream.addTrack(e.track);
      if (video.srcObject !== stream) {
        video.removeAttribute('src');
        video.srcObject = stream;
      }
      mode = 'stream';
      playStream();
    };
    conn.onicecandidate = function (e) {
      if (e.candidate && conn === pc) {
        send({ type: 'candidate', candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
      }
    };
    conn.oniceconnectionstatechange = function () {
      if (conn !== pc) return;
      var s = conn.iceConnectionState;
      send({ type: 'receiver-state', state: s });
      clearTimeout(disconnectTimer);
      if (s === 'failed') {
        stopAll();
        toast("Couldn't connect to your Mac. Check both are on the same Wi-Fi, and that the Mac's firewall allows Fire TV Cast.", 9000);
      } else if (s === 'disconnected') {
        disconnectTimer = setTimeout(function () {
          if (conn === pc && conn.iceConnectionState !== 'connected' && conn.iceConnectionState !== 'completed') {
            stopAll();
            toast('Connection lost');
          }
        }, 6000);
      } else if (s === 'connected' || s === 'completed') {
        $('#spinner').classList.add('hidden');
      }
    };

    return conn.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }))
      .then(function () { return conn.createAnswer(); })
      .then(function (answer) {
        return conn.setLocalDescription(new RTCSessionDescription({ type: 'answer', sdp: enableStereoOpus(answer.sdp) }));
      })
      .then(function () {
        send({ type: 'answer', sdp: conn.localDescription.sdp });
        startStats();
      })
      .catch(function (e) {
        console.error('offer failed', e);
        send({ type: 'receiver-error', message: String(e && e.message || e) });
        stopAll();
        toast('This TV could not start the stream: ' + (e && e.message || e), 8000);
      });
  }

  // Ask the sender for full-quality stereo audio instead of the voice-call default.
  function enableStereoOpus(sdp) {
    var m = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp);
    if (!m) return sdp;
    var pt = m[1];
    var re = new RegExp('(a=fmtp:' + pt + ' [^\\r\\n]*)', 'i');
    if (re.test(sdp)) {
      return sdp.replace(re, function (line) {
        if (/stereo=/.test(line)) return line;
        return line + ';stereo=1;sprop-stereo=1;maxaveragebitrate=256000';
      });
    }
    return sdp;
  }

  function closePc() {
    clearTimeout(disconnectTimer);
    if (pc) {
      var old = pc;
      pc = null;
      try { old.close(); } catch (e) {}
    }
    stopStats();
  }

  // ---------- Link playback ----------

  function playUrl(url) {
    closePc();
    showCast(true);
    mode = 'url';
    video.srcObject = null;
    video.src = url;
    video.onerror = function () {
      send({ type: 'playback', state: 'error', message: 'The TV could not play this link.' });
      toast('The TV could not play this link', 6000);
      stopAll();
    };
    playVideo();
    clearInterval(playbackTimer);
    playbackTimer = setInterval(reportPlayback, 1000);
  }

  function stopUrl() {
    clearInterval(playbackTimer);
    playbackTimer = null;
    video.onerror = null;
    if (video.getAttribute('src')) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
  }

  function reportPlayback() {
    if (mode !== 'url') return;
    send({
      type: 'playback',
      state: video.ended ? 'ended' : (video.paused ? 'paused' : 'playing'),
      currentTime: video.currentTime || 0,
      duration: isFinite(video.duration) ? video.duration : 0
    });
  }

  function control(msg) {
    if (mode !== 'url') return;
    if (msg.action === 'toggle') { if (video.paused) video.play(); else video.pause(); }
    else if (msg.action === 'play') video.play();
    else if (msg.action === 'pause') video.pause();
    else if (msg.action === 'seek') video.currentTime = Math.max(0, (video.currentTime || 0) + (msg.delta || 0));
    else if (msg.action === 'seekTo') video.currentTime = Math.max(0, msg.time || 0);
    reportPlayback();
  }

  // ---------- Screens ----------

  // Links play their own sound through the <video> element.
  function playVideo() {
    video.muted = false;
    var p = video.play();
    if (p && p.catch) {
      p.then(function () { $('#spinner').classList.add('hidden'); }).catch(function () {
        // Autoplay with sound was blocked; play muted and ask for a button press.
        video.muted = true;
        video.play().catch(function () {});
        showSoundPrompt();
      });
    }
  }

  // Casts: the <video> always plays muted (browsers never block that) and the sound goes
  // through the Web Audio context that was unlocked when Start was pressed. TV browsers
  // often won't pass remote buttons to the page while video plays, so we can't rely on
  // a second button press to unmute.
  function playStream() {
    video.muted = true;
    var p = video.play();
    if (p && p.catch) p.catch(function () {});
    routeStreamAudio();
  }

  function routeStreamAudio() {
    var stream = video.srcObject;
    if (!stream || !stream.getAudioTracks || !stream.getAudioTracks().length) return;
    if (!audioCtx) { showSoundPrompt(); return; }
    if (audioCtx.state !== 'running') {
      var r = audioCtx.resume && audioCtx.resume();
      if (r && r.then) {
        r.then(function () {
          if (audioCtx.state === 'running' && mode === 'stream') routeStreamAudio();
          else showSoundPrompt();
        }).catch(showSoundPrompt);
      } else {
        showSoundPrompt();
      }
      return;
    }
    disconnectAudio();
    try {
      audioSrc = audioCtx.createMediaStreamSource(stream);
      audioSrc.connect(audioCtx.destination);
      hideSoundPrompt();
    } catch (e) {
      console.warn('web audio routing failed, falling back to the video element', e);
      video.muted = false;
      var p = video.play();
      if (p && p.catch) p.catch(function () { video.muted = true; video.play().catch(function () {}); showSoundPrompt(); });
    }
  }

  function disconnectAudio() {
    if (audioSrc) { try { audioSrc.disconnect(); } catch (e) {} audioSrc = null; }
  }

  function ensureAudioCtx() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!audioCtx && AC) audioCtx = new AC();
      if (audioCtx && audioCtx.resume) { var r = audioCtx.resume(); if (r && r.catch) r.catch(function () {}); }
    } catch (e) {}
  }

  var soundPromptVisible = false;
  function showSoundPrompt() {
    if (mode === 'idle') return;
    soundPromptVisible = true;
    var b = $('#soundBtn');
    b.classList.remove('hidden');
    try { b.focus(); } catch (e) {}
  }
  function hideSoundPrompt() {
    soundPromptVisible = false;
    $('#soundBtn').classList.add('hidden');
  }

  // Called from any button press / click while the sound prompt is showing.
  function unlockSound() {
    ensureAudioCtx();
    hideSoundPrompt();
    if (mode === 'stream') {
      routeStreamAudio();
    } else if (mode === 'url') {
      video.muted = false;
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    }
    toast('Sound on', 1500);
  }
  $('#soundBtn').addEventListener('click', function (e) { e.stopPropagation(); unlockSound(); });
  ['pointerdown', 'mousedown', 'touchstart', 'click'].forEach(function (t) {
    document.addEventListener(t, function () { if (soundPromptVisible) unlockSound(); }, true);
  });
  video.addEventListener('playing', function () { $('#spinner').classList.add('hidden'); });
  video.addEventListener('waiting', function () { if (mode === 'url') $('#spinner').classList.remove('hidden'); });

  function showCast(loading) {
    $('#idle').classList.add('hidden');
    $('#cast').classList.remove('hidden');
    $('#spinner').classList.toggle('hidden', !loading);
  }

  function stopAll() {
    disconnectAudio();
    hideSoundPrompt();
    closePc();
    stopUrl();
    video.srcObject = null;
    mode = 'idle';
    $('#cast').classList.add('hidden');
    $('#idle').classList.remove('hidden');
  }

  function toast(text, ms) {
    var el = $('#toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, ms || 3500);
  }

  // ---------- Remote control (called from the Android activity) ----------

  window.remoteKey = function (key) {
    switch (key) {
      case 'back':
        if (statsVisible) { toggleStats(); return true; }
        if (mode !== 'idle') {
          stopAll();
          send({ type: 'receiver-stopped' });
          toast('Stopped casting');
          return true;
        }
        return false;
      case 'menu':
        toggleStats();
        return true;
      case 'ok':
        if (!started) { start(); return true; }
        // falls through
      case 'playpause':
        if (soundPromptVisible) { unlockSound(); return true; }
        if (mode === 'url') control({ action: 'toggle' });
        return true;
      case 'forward':
        if (mode === 'url') { control({ action: 'seek', delta: 30 }); toast('+30s', 1000); }
        return true;
      case 'rewind':
        if (mode === 'url') { control({ action: 'seek', delta: -10 }); toast('−10s', 1000); }
        return true;
    }
    return false;
  };

  // Keyboard fallback when testing in a desktop browser.
  document.addEventListener('keydown', function (e) {
    // Any button at all turns the sound on if we're waiting for one.
    if (soundPromptVisible && e.key !== 'Escape' && e.key !== 'GoBack' && e.key !== 'BrowserBack') { unlockSound(); e.preventDefault(); return; }
    var map = { Escape: 'back', Enter: 'ok', ' ': 'playpause', MediaPlayPause: 'playpause', MediaFastForward: 'forward', MediaRewind: 'rewind', ArrowRight: 'forward', ArrowLeft: 'rewind', i: 'menu', ContextMenu: 'menu' };
    if (e.key === 'Enter' && !started) { start(); e.preventDefault(); return; }
    if (map[e.key]) { window.remoteKey(map[e.key]); e.preventDefault(); }
  });

  // ---------- Stats overlay (Menu button) ----------

  function toggleStats() {
    statsVisible = !statsVisible;
    $('#stats').classList.toggle('hidden', !statsVisible);
    if (statsVisible) updateStats();
  }
  function startStats() { stopStats(); statsTimer = setInterval(updateStats, 1000); }
  function stopStats() { clearInterval(statsTimer); statsTimer = null; lastStats = null; }

  function updateStats() {
    if (!statsVisible) return;
    if (mode === 'url') {
      $('#stats').textContent = 'Playing link\n' + (video.videoWidth + 'x' + video.videoHeight);
      return;
    }
    if (!pc || !pc.getStats) { $('#stats').textContent = 'Not casting'; return; }
    pc.getStats().then(function (report) {
      var v = null, codecs = {}, pair = null;
      report.forEach(function (s) {
        if (s.type === 'inbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) v = s;
        if (s.type === 'codec') codecs[s.id] = s;
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
      });
      if (!v) { $('#stats').textContent = 'Waiting for video…'; return; }
      var now = performance.now(), kbps = 0;
      if (lastStats) kbps = ((v.bytesReceived - lastStats.bytes) * 8) / (now - lastStats.t);
      lastStats = { bytes: v.bytesReceived, t: now };
      var codec = v.codecId && codecs[v.codecId] ? codecs[v.codecId].mimeType : '?';
      $('#stats').textContent = [
        'Resolution  ' + (v.frameWidth || video.videoWidth) + 'x' + (v.frameHeight || video.videoHeight),
        'Frame rate  ' + (v.framesPerSecond != null ? v.framesPerSecond : '?') + ' fps',
        'Bitrate     ' + (kbps / 1000).toFixed(1) + ' Mbps',
        'Codec       ' + codec + (v.decoderImplementation ? ' (' + v.decoderImplementation + ')' : ''),
        'Lost        ' + (v.packetsLost || 0) + ' packets',
        'Dropped     ' + (v.framesDropped || 0) + ' frames',
        'RTT         ' + (pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) + ' ms' : '?')
      ].join('\n');
    }).catch(function () {});
  }

  // ---------- Idle screen, start button, capabilities ----------

  function setStatus(text, ok) {
    var el = $('#status');
    el.textContent = text;
    el.className = 'status' + (ok ? ' ok' : '');
  }

  function videoCodecs() {
    try {
      var caps = window.RTCRtpReceiver && RTCRtpReceiver.getCapabilities && RTCRtpReceiver.getCapabilities('video');
      if (!caps) return [];
      var seen = {}, out = [];
      caps.codecs.forEach(function (c) {
        var m = c.mimeType.toLowerCase();
        if (!seen[m] && !/rtx|red|ulpfec|flexfec/.test(m)) { seen[m] = true; out.push(m); }
      });
      return out;
    } catch (e) { return []; }
  }

  function tvInfo() {
    return {
      type: 'tv-info',
      ua: navigator.userAgent,
      webrtc: !!window.RTCPeerConnection,
      codecs: videoCodecs(),
      screen: screen.width + 'x' + screen.height,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      started: started
    };
  }

  function showChecks() {
    var codecs = videoCodecs();
    var has = function (c) { return codecs.indexOf(c) >= 0 ? '✓' : '✗'; };
    $('#checks').textContent = 'WebRTC ' + (window.RTCPeerConnection ? '✓' : '✗') +
      ' · H.264 ' + has('video/h264') + ' · VP8 ' + has('video/vp8') + ' · VP9 ' + has('video/vp9');
    if (!window.RTCPeerConnection) {
      $('#note').textContent = "This browser can't receive live video (no WebRTC). Casting won't work here – only “Play a link” can.";
    }
  }

  function start() {
    if (started) return;
    started = true;
    // Full screen and an audio "unlock" both need a button press, so we ask for one up front.
    try {
      var el = document.documentElement;
      var fs = el.requestFullscreen || el.webkitRequestFullscreen;
      if (fs) { var p = fs.call(el); if (p && p.catch) p.catch(function () {}); }
    } catch (e) {}
    ensureAudioCtx();
    $('#startPanel').classList.add('hidden');
    $('#readyPanel').classList.remove('hidden');
    send(tvInfo());
  }
  $('#startBtn').addEventListener('click', start);

  // Let the remote's Back button stop casting instead of leaving the page.
  try { history.pushState({ ftv: 1 }, ''); } catch (e) {}
  window.addEventListener('popstate', function () {
    if (mode !== 'idle' || statsVisible) {
      window.remoteKey('back');
      try { history.pushState({ ftv: 1 }, ''); } catch (e) {}
    } else {
      history.back();
    }
  });

  fetch('/api/info', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (info) {
    hostName = info.hostname || '';
    $('#version').textContent = 'v' + (info.version || '');
    if (ws && ws.readyState === 1) setStatus('Connected to ' + (hostName || 'your Mac'), true);
  }).catch(function () {});

  showChecks();
  setTimeout(function () { var b = $('#startBtn'); if (b && !started) b.focus(); }, 300);
  connect();
})();
