/* Sound check: plays four beeps made in four different ways, so we can tell which
   audio paths actually reach the speakers in this TV browser. */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var lines = [];
  function log(t) { lines.push(t); $('#log').textContent = lines.join('\n'); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function report() {
    try {
      fetch('/api/tvlog', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ua: navigator.userAgent, results: lines }) });
    } catch (e) {}
  }

  var ctx = null;

  // Each test returns a promise; errors are logged and the next test still runs.
  var tests = [
    { name: 'a normal web sound (like YouTube)', run: function () {
        var a = new Audio('/beep.wav?f=440');
        a.volume = 1;
        return a.play().then(function () { return sleep(1300); });
      } },
    { name: 'the Web Audio engine (used by the test tone and method A)', run: function () {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) throw new Error('no Web Audio');
        ctx = ctx || new AC();
        return Promise.resolve(ctx.resume && ctx.resume()).then(function () {
          log('    engine state: ' + ctx.state + ', ' + ctx.sampleRate + ' Hz');
          var o = ctx.createOscillator(), g = ctx.createGain();
          o.frequency.value = 554; g.gain.value = 0.3;
          o.connect(g); g.connect(ctx.destination);
          o.start(); o.stop(ctx.currentTime + 1.2);
          return sleep(1300);
        });
      } },
    { name: 'a live stream played by the video player (method B)', run: function () {
        return loopback().then(function (lb) {
          var a = document.createElement('audio');
          a.autoplay = true;
          a.srcObject = lb.stream;
          document.body.appendChild(a);
          return a.play().then(function () { return sleep(1500); }).then(function () {
            log('    paused=' + a.paused + ' muted=' + a.muted);
            a.remove(); lb.close();
          });
        });
      } },
    { name: 'a live stream played through Web Audio (method A)', run: function () {
        return loopback().then(function (lb) {
          var holder = document.createElement('audio');
          holder.muted = true; holder.srcObject = lb.stream; holder.play().catch(function () {});
          var src = ctx.createMediaStreamSource(lb.stream);
          src.connect(ctx.destination);
          return sleep(1500).then(function () { src.disconnect(); lb.close(); });
        });
      } }
  ];

  // A tone sent through a real WebRTC connection inside this page (no Mac needed).
  function loopback() {
    var AC = window.AudioContext || window.webkitAudioContext;
    ctx = ctx || new AC();
    var o = ctx.createOscillator(), dest = ctx.createMediaStreamDestination(), g = ctx.createGain();
    o.frequency.value = 0; g.gain.value = 0.3;
    o.connect(g); g.connect(dest); o.start();
    var pitch = lines.length; // vary pitch per test
    o.frequency.value = 660 + (pitch % 4) * 60;
    var a = new RTCPeerConnection(), b = new RTCPeerConnection();
    a.onicecandidate = function (e) { if (e.candidate) b.addIceCandidate(e.candidate); };
    b.onicecandidate = function (e) { if (e.candidate) a.addIceCandidate(e.candidate); };
    dest.stream.getTracks().forEach(function (t) { a.addTrack(t, dest.stream); });
    var got = new Promise(function (res) { b.ontrack = function (e) { res(e.streams[0] || new MediaStream([e.track])); }; });
    return a.createOffer().then(function (off) { return a.setLocalDescription(off); })
      .then(function () { return b.setRemoteDescription(a.localDescription); })
      .then(function () { return b.createAnswer(); })
      .then(function (ans) { return b.setLocalDescription(ans); })
      .then(function () { return a.setRemoteDescription(b.localDescription); })
      .then(function () { return got; })
      .then(function (stream) {
        return { stream: stream, close: function () { o.stop(); a.close(); b.close(); } };
      });
  }

  function runAll() {
    $('#go').classList.add('hidden');
    $('#intro').textContent = 'Listen… note which numbers you hear.';
    lines = [];
    var i = 0;
    function next() {
      if (i >= tests.length) {
        $('#big').textContent = 'Done';
        $('#what').textContent = 'Which numbers did you hear? (1, 2, 3, 4 or none)';
        var back = $('#back'); back.classList.remove('hidden');
        var again = $('#go'); again.textContent = 'Play again'; again.classList.remove('hidden');
        try { again.focus(); } catch (e) {}
        report();
        return;
      }
      var t = tests[i], n = i + 1;
      i++;
      $('#big').textContent = 'Sound ' + n;
      $('#what').textContent = t.name;
      log(n + ') ' + t.name);
      var p;
      try { p = Promise.resolve(t.run()); } catch (e) { p = Promise.reject(e); }
      p.then(function () { log('    played'); }, function (e) { log('    FAILED: ' + (e && (e.name + ': ' + e.message) || e)); })
        .then(function () { $('#big').textContent = ''; return sleep(900); })
        .then(next);
    }
    next();
  }

  $('#go').addEventListener('click', runAll);
  $('#back').addEventListener('click', function () { location.href = '/'; });
  document.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && document.activeElement === document.body) { runAll(); e.preventDefault(); }
  });
  setTimeout(function () { try { $('#go').focus(); } catch (e) {} }, 300);
})();
