/* Fire TV Cast – receiver page that runs inside the TV app's WebView. */
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

  // ---------- Signaling ----------

  function connect() {
    ws = new WebSocket('ws://' + location.host + '/ws?role=receiver');
    ws.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      // Process strictly in order (answer before candidates, etc).
      queue = queue.then(function () { return handle(msg); }).catch(function (err) {
        console.error('handle failed', err);
      });
    };
    ws.onclose = function () { if (!replaced) setTimeout(connect, 1000); };
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
        toast('Connected to ' + (msg.name || 'your computer'));
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
      playVideo();
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
        toast("Couldn't connect to your Mac. Check both are on the same Wi-Fi.", 8000);
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

  function playVideo() {
    video.muted = false;
    var p = video.play();
    if (p && p.catch) {
      p.then(function () { $('#spinner').classList.add('hidden'); }).catch(function () {
        // Autoplay with sound was blocked; play muted and let the remote unmute.
        video.muted = true;
        video.play().catch(function () {});
        toast('Press OK on your remote to turn on sound', 6000);
      });
    }
  }
  video.addEventListener('playing', function () { $('#spinner').classList.add('hidden'); });
  video.addEventListener('waiting', function () { if (mode === 'url') $('#spinner').classList.remove('hidden'); });

  function showCast(loading) {
    $('#idle').classList.add('hidden');
    $('#cast').classList.remove('hidden');
    $('#spinner').classList.toggle('hidden', !loading);
  }

  function stopAll() {
    closePc();
    stopUrl();
    video.srcObject = null;
    mode = 'idle';
    $('#cast').classList.add('hidden');
    $('#idle').classList.remove('hidden');
    refreshInfo();
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
      case 'playpause':
        if (video.muted && mode !== 'idle') { video.muted = false; toast('Sound on'); return true; }
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
  window.onTvResume = function () { refreshInfo(); };

  // Keyboard fallback when testing in a desktop browser.
  document.addEventListener('keydown', function (e) {
    var map = { Escape: 'back', Enter: 'ok', ' ': 'playpause', ArrowRight: 'forward', ArrowLeft: 'rewind', i: 'menu', ContextMenu: 'menu' };
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

  // ---------- Idle screen info ----------

  function refreshInfo() {
    fetch('/api/info', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (info) {
      var box = $('#urls');
      box.innerHTML = '';
      if (!info.ips || !info.ips.length) {
        box.innerHTML = '<span class="url muted">Connect this Fire TV to Wi‑Fi to start casting.</span>';
      } else {
        info.ips.forEach(function (ip, i) {
          var el = document.createElement('span');
          el.className = 'url' + (i > 0 ? ' secondary' : '');
          el.textContent = 'https://' + ip + ':' + info.httpsPort;
          box.appendChild(el);
        });
      }
      var note = '';
      if (!info.httpsReady) note = info.httpsError ? ('Secure server failed: ' + info.httpsError) : 'Preparing secure connection… (first launch only)';
      if (!window.RTCPeerConnection) note = "This TV's web engine doesn't support WebRTC – screen mirroring won't work.";
      $('#note').textContent = note;
      $('#device').textContent = info.name || '';
      $('#version').textContent = 'v' + (info.version || '');
      if (!info.httpsReady) setTimeout(refreshInfo, 1500);
    }).catch(function () { setTimeout(refreshInfo, 2000); });
  }

  setInterval(function () { if (mode === 'idle') refreshInfo(); }, 15000);
  refreshInfo();
  connect();
})();
