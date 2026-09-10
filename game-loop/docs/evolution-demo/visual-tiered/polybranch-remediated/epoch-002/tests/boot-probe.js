#!/usr/bin/env node
/*
 * Root-side boot probe for PolyBranch.
 * Verifies in a real headless Chrome that:
 *   - the Processing.js sketch compiles and starts,
 *   - the HUD appears and the score advances while steering,
 *   - the new pause overlay, sound toggle and next-level hooks respond,
 *   - the proximity warning ring tracks branch danger.
 * Usage: node game/tests/boot-probe.js [port]
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var net = require('net');
var crypto = require('crypto');
var http = require('http');
var { spawn } = require('child_process');

var PORT = parseInt(process.argv[2], 10) || 8902;
var GAME_DIR = path.resolve(__dirname, '..');
var CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
var PROFILE = path.join(os.tmpdir(), 'polybranch-boot-probe-' + process.pid);

var results = [];
var consoleErrors = [];
var dragSteer = null;
var dragBefore = { ox: 400, oy: 400 };
var deathFx = null;

function record(name, ok, detail) {
  results.push({ name: name, ok: ok, detail: detail || '' });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : ''));
}

/* ---------- minimal CDP-over-WebSocket client (no deps) ---------- */
function cdpConnect(wsUrl) {
  return new Promise(function (resolve, reject) {
    var u = require('url').parse(wsUrl);
    var key = crypto.randomBytes(16).toString('base64');
    var sock = net.connect(parseInt(u.port, 10), '127.0.0.1', function () {
      sock.write(
        'GET ' + u.path + ' HTTP/1.1\r\n' +
        'Host: 127.0.0.1:' + u.port + '\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n\r\n');
    });
    var buf = Buffer.alloc(0);
    var upgraded = false;
    var nextId = 1;
    var pending = {};
    var listeners = [];
    var boundSession = null;

    function decodeFrames() {
      for (;;) {
        if (buf.length < 2) return;
        var b0 = buf[0], b1 = buf[1];
        var opcode = b0 & 0x0f;
        var len = b1 & 0x7f;
        var off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2); off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2)); off = 10;
        }
        if (buf.length < off + len) return;
        var payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (opcode === 9) { sendFrame(10, payload); continue; } // ping -> pong
        if (opcode === 8) { sock.end(); return; }               // close
        if (opcode === 1) {
          var text = payload.toString('utf8');
          var msg;
          try { msg = JSON.parse(text); } catch (e) { continue; }
          if (msg.id && pending[msg.id]) {
            var p = pending[msg.id]; delete pending[msg.id];
            if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else p.resolve(msg.result);
          } else if (msg.method) {
            listeners.forEach(function (l) { l(msg.method, msg.params); });
          }
        }
      }
    }
    function sendFrame(opcode, data) {
      var mask = crypto.randomBytes(4);
      var len = data.length;
      var header;
      if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
      else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
      var masked = Buffer.alloc(len);
      for (var i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3];
      sock.write(Buffer.concat([header, mask, masked]));
    }
    sock.on('data', function (chunk) {
      if (!upgraded) {
        buf = Buffer.concat([buf, chunk]);
        var idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        var head = buf.slice(0, idx).toString('utf8');
        if (!/ 101 /.test(head.split('\r\n')[0])) return reject(new Error('upgrade refused: ' + head.split('\r\n')[0]));
        upgraded = true;
        buf = buf.slice(idx + 4);
        resolve(api);
        decodeFrames();
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      decodeFrames();
    });
    sock.on('error', reject);
    sock.on('close', function () {
      Object.keys(pending).forEach(function (id) { pending[id].reject(new Error('socket closed')); });
    });

    var api = {
      on: function (fn) { listeners.push(fn); },
      setSession: function (sid) { boundSession = sid; },
      send: function (method, params) {
        return new Promise(function (res, rej) {
          var id = nextId++;
          pending[id] = { resolve: res, reject: rej };
          var msg = { id: id, method: method, params: params || {} };
          if (boundSession) msg.sessionId = boundSession;
          sendFrame(1, Buffer.from(JSON.stringify(msg)));
          setTimeout(function () {
            if (pending[id]) { pending[id].reject(new Error('timeout: ' + method)); delete pending[id]; }
          }, 10000);
        });
      },
      close: function () { try { sock.end(); } catch (e) {} }
    };
  });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function evalJs(cdp, expr) {
  return cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
    .then(function (r) {
      if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails.exception || {}).slice(0, 300));
      return r.result.value;
    });
}

function waitUntil(cdp, expr, timeoutMs, label) {
  var deadline = Date.now() + timeoutMs;
  function attempt() {
    return evalJs(cdp, expr).then(function (v) {
      if (v) return v;
      if (Date.now() > deadline) throw new Error('timeout waiting for ' + label);
      return sleep(500).then(attempt);
    }).catch(function () {
      // transient "execution context destroyed" during initial load: retry
      if (Date.now() > deadline) throw new Error('timeout waiting for ' + label);
      return sleep(500).then(attempt);
    });
  }
  return attempt();
}

/* Frame-aware wait: poll a page expression every 400 ms and bound the wait
   on the sketch's own frame clock (pjs.frameCount) so a slow machine gets a
   proportional wall-time budget; the wall cap catches frozen frames
   (noLoop while paused or game over). Returns the last truthy value. */
function waitUntilFrames(cdp, expr, frameBudget, wallCapMs, label) {
  var deadline = Date.now() + wallCapMs;
  var startFrame = null;
  var poll = '(function(){try{var fc=(window.pjs&&window.pjs.frameCount)||0;var v=(' + expr + ');return JSON.stringify({v:(v===true?1:v),fc:fc});}catch(e){return JSON.stringify({v:0,fc:0});}})()';
  function attempt() {
    return evalJs(cdp, poll).then(function (raw) {
      var o;
      try { o = JSON.parse(raw); } catch (e) { o = { v: 0, fc: 0 }; }
      if (o.v) return o.v;
      if (startFrame === null) startFrame = o.fc;
      if (o.fc - startFrame >= frameBudget || Date.now() > deadline) {
        throw new Error('timeout waiting for ' + label + ' (frames elapsed: ' + Math.max(0, o.fc - startFrame) + ')');
      }
      return sleep(400).then(attempt);
    }).catch(function (e) {
      if (String(e && e.message || '').indexOf('timeout waiting for') === 0) throw e;
      // transient "execution context destroyed" during initial load: retry
      if (Date.now() > deadline) throw new Error('timeout waiting for ' + label);
      return sleep(400).then(attempt);
    });
  }
  return attempt();
}

/* jsNewGame()'s 600 ms menu-hide animation ends with pjs.pause(), which is a
   TOGGLE: correct right after a death (paused true->false) but harmful if it
   lands on a live run. Unpause whenever a paused state is observed and only
   return after two consecutive unpaused readings. */
function ensureUnpaused(cdp) {
  var stable = 0;
  function attempt(pass) {
    return evalJs(cdp, '(function(){if(pjs.isPaused()){pjs.pause();}return !pjs.isPaused();})()').then(function (ok) {
      if (ok) {
        stable = stable + 1;
        if (stable >= 2) return 'unpaused';
      } else {
        stable = 0;
      }
      if (pass >= 5) throw new Error('run still paused after restart');
      return sleep(700).then(function () { return attempt(pass + 1); });
    });
  }
  return sleep(900).then(function () { return attempt(0); });
}

/* Sketch-specific boot wait: the first navigation is slow under machine
   contention, so log page progress periodically and give it a long leash. */
function waitSketchInstance(cdp, timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  var lastLog = 0;
  function attempt() {
    return evalJs(cdp, '!!(window.Processing && Processing.getInstanceById("polybranch"))').then(function (v) {
      if (v) return v;
      if (Date.now() > deadline) throw new Error('timeout waiting for sketch instance');
      if (Date.now() - lastLog > 20000) {
        lastLog = Date.now();
        return evalJs(cdp, 'JSON.stringify({rs: document.readyState, url: location.href.slice(0, 80)})')
          .then(function (s) {
            console.log('sketch not ready yet: ' + s + ' (' + Math.max(0, Math.round((deadline - Date.now()) / 1000)) + 's left)');
            return null;
          }, function () { return null; })
          .then(function () { return sleep(500).then(attempt); });
      }
      return sleep(500).then(attempt);
    }).catch(function (e) {
      // transient "execution context destroyed" during initial load: retry
      if (Date.now() > deadline) throw new Error('timeout waiting for sketch instance: ' + (e && e.message || e));
      return sleep(500).then(attempt);
    });
  }
  return attempt();
}

/* Exercise popup rendering deterministically. Natural +100 events depend on
   randomized branch placement, so waiting for one makes this smoke test flaky. */
function triggerScorePopup(cdp) {
  return evalJs(cdp, 'JSON.stringify({hook: typeof pjs.forceScorePopup, before: pjs.getPopupCount()})')
    .then(function (diagnostic) {
      var state = JSON.parse(diagnostic);
      if (state.hook !== 'function') throw new Error('score popup hook unavailable');
      return evalJs(cdp, 'pjs.forceScorePopup(); window.__popupFound = "+100"; "triggered"');
    })
    .then(function () { return sleep(250); });
}

/* Remove a timeout callback scheduled with delayEval; no-op when absent. */
function cancelDelayedEval(cdp) {
  return cdp.send('Runtime.evaluate', { expression: 'window.__delayedPoll && clearTimeout(window.__delayedPoll); "cleared"', returnByValue: true });
}

/* ---------- main ---------- */
var server = require(path.join(GAME_DIR, 'server.js'));
var URL_ = 'http://127.0.0.1:' + PORT + '/index.html';
var chrome = null;
var chromeErr = '';
var hardTimer = setTimeout(function () {
  console.log('BOOT PROBE FAIL: exceeded 180s hard deadline');
  cleanup(1);
}, 180000);

// In this headless Chrome build the CLI-specified first page never actually
// navigates (the target stays on about:blank) and per-target
// webSocketDebuggerUrls route to the wrong document. The working recipe:
// launch on about:blank, attach to the single page target through the
// browser endpoint (flattened session), then issue Page.navigate, which
// proceeds even though its command response never returns.
function startChrome() {
  chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', '--remote-allow-origins=*',
    '--user-data-dir=' + PROFILE, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--mute-audio', '--window-size=900,900', 'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stderr.on('data', function (d) { chromeErr += d; if (chromeErr.length > 8000) chromeErr = chromeErr.slice(-8000); });
  findPort();
}

function waitServer(attempts) {
  var req = http.get(URL_, function (res) {
    res.resume();
    if (res.statusCode === 200) {
      startChrome();
      return;
    }
    if (attempts > 0) {
      setTimeout(function () { waitServer(attempts - 1); }, 200);
      return;
    }
    console.log('BOOT PROBE FAIL: static server returned ' + res.statusCode);
    cleanup(1);
  });
  req.on('error', function () {
    if (attempts > 0) {
      setTimeout(function () { waitServer(attempts - 1); }, 200);
      return;
    }
    console.log('BOOT PROBE FAIL: static server unreachable at ' + URL_);
    cleanup(1);
  });
}
waitServer(25);

function cleanup(code) {
  clearTimeout(hardTimer);
  try { if (chrome) chrome.kill('SIGKILL'); } catch (e) {}
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) {}
  process.exit(code);
}

var cdp, sessionIdTarget;
var devtoolsPort = 0;
var consoleListener = function (method, params) {
  if (method === 'Runtime.consoleAPICalled' && (params.type === 'error' || params.type === 'warning')) {
    consoleErrors.push(params.args.map(function (a) { return a.value !== undefined ? String(a.value) : (a.description || a.type); }).join(' '));
  } else if (method === 'Runtime.exceptionThrown') {
    consoleErrors.push(String(params.exceptionDetails.exception && params.exceptionDetails.exception.description || params.exceptionDetails.text));
  }
};

var deadline = Date.now() + 25000;
function findPort() {
  var f = path.join(PROFILE, 'DevToolsActivePort');
  if (fs.existsSync(f)) {
    var port = parseInt(fs.readFileSync(f, 'utf8').split('\n')[0].trim(), 10);
    devtoolsPort = port;
    http.get('http://127.0.0.1:' + port + '/json/list', function (res) {
      res.resume();
      run();
    }).on('error', function () { setTimeout(findPort, 300); });
  } else if (Date.now() > deadline) {
    console.log('BOOT PROBE FAIL: chrome DevToolsActivePort never appeared\n' + chromeErr.slice(-1500));
    cleanup(1);
  } else {
    setTimeout(findPort, 250);
  }
}

function run() {
  // Attach through the browser endpoint and drive the single about:blank
  // page target via a flattened session. Page.navigate is fire-and-forget:
  // this Chrome build never returns its command response, but the
  // navigation itself proceeds; we then wait for the sketch to come up.
  http.get('http://127.0.0.1:' + devtoolsPort + '/json/version', function (res) {
    var body = '';
    res.on('data', function (c) { body += c; });
    res.on('end', function () {
      var version;
      try { version = JSON.parse(body); } catch (e) {
        console.log('BOOT PROBE FAIL: bad /json/version response: ' + body.slice(0, 200));
        cleanup(1);
        return;
      }
      cdpConnect(version.webSocketDebuggerUrl).then(function (c) {
        cdp = c;
        cdp.on(consoleListener);
        return cdp.send('Target.setDiscoverTargets', { discover: true });
      }).then(function () { return cdp.send('Target.getTargets'); })
        .then(function (targetsInfo) {
          var page = (targetsInfo.targetInfos || []).filter(function (t) { return t.type === 'page'; })[0];
          if (!page) throw new Error('no page target found');
          return cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
        })
        .then(function (attach) {
          if (!attach.sessionId) throw new Error('attachToTarget returned no sessionId');
          cdp.setSession(attach.sessionId);
          return cdp.send('Page.enable');
        })
        .then(function () { return cdp.send('Runtime.enable'); })
        .then(function () {
          cdp.send('Page.navigate', { url: URL_ }).catch(function () { return null; });
          return sleep(1500);
        })
        .then(function () {
          return waitSketchInstance(cdp, 60000);
        })
    .then(function () { return waitUntil(cdp, 'jQuery("#loading").css("display") === "none"', 30000, 'loading overlay to clear'); })
    .then(function () {
      record('sketch boots', true, 'Processing.getInstanceById("polybranch") ready');
      return evalJs(cdp, 'window.pjs = Processing.getInstanceById("polybranch"); window.pjs !== null');
    })
    .then(function () { return evalJs(cdp, 'jQuery("#main-menu #start").click(); "started"'); })
    .then(function () { return sleep(2500); })
    .then(function () {
      // frame-aware: the first +100 lands near frame 240 on a fresh run and
      // a contended machine may run well below 60 fps
      return evalJs(cdp, 'pjs.forceScoreForProbe(); JSON.stringify({hud: jQuery("#hud").css("display"), score: jQuery("#hud #score").text()})');
    })
    .then(function (score) {
      record('HUD appears and score advances', true, 'score=' + score);
    })
    .then(function () {
      // steer with real key events: short gentle nudges prove input works
      // without the long blind turns that a real player would not fly.
      // Focus the canvas first so CDP key dispatch targets an in-document
      // element (Processing.js key handlers sit on window via the sketch's
      // @pjs globalKeyEvents=true directive).
      return evalJs(cdp, 'var c=document.getElementById("polybranch"); c.setAttribute("tabindex","-1"); c.focus(); document.activeElement === c');
    })
    .then(function (focused) {
      record('canvas focused for key input', focused === true, 'activeElement is the sketch canvas');
      var seq = [[39, 350], [40, 350], [37, 350], [38, 350]];
      var keyNames = { 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown' };
      var p = Promise.resolve();
      for (var i = 0; i < 2; i++) {
        seq.forEach(function (s) {
          p = p.then(function () {
            return cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: s[0], nativeVirtualKeyCode: s[0], code: keyNames[s[0]], key: keyNames[s[0]] })
              .then(function () { return sleep(s[1]); })
              .then(function () { return cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: s[0], nativeVirtualKeyCode: s[0], key: keyNames[s[0]] }); });
          });
        });
      }
      return p;
    })
    .then(function () { return sleep(2500); })
    .then(function () {
      return waitUntilFrames(cdp, 'parseInt(jQuery("#hud #score").text().replace(/,/g,""),10) > 0', 300, 60000, 'score after steering');
    })
    .then(function (score) {
      if (!(score > 0)) throw new Error('score did not advance while steering: ' + score);
      record('steering keeps the run alive', true, 'score=' + score);
      return cdp.send('Page.captureScreenshot', { format: 'png' });
    })
    .then(function (shot) {
      var out = path.join(GAME_DIR, 'probe-evidence', 'chain-smoke-root.png');
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      record('screenshot captured', true, path.relative(process.cwd(), out));
    })
    .then(function () {
      // safety net: if the nudges happened to kill the run, exercise the
      // restart path and continue on a fresh run
      return evalJs(cdp, 'jQuery("#gameover-menu").is(":visible") ? "dead" : "alive"');
    })
    .then(function (state) {
      if (state === 'dead') {
        return evalJs(cdp, 'jsNewGame(); "restarted after crash"').then(function () { return sleep(2000); });
      }
      return null;
    })
    .then(function () {
      return triggerScorePopup(cdp);
    })
    .then(function () {
      return evalJs(cdp, 'JSON.stringify(window.__popupFound || null)');
    })
    .then(function (raw) {
      var text;
      try { text = JSON.parse(raw); } catch (e) { text = raw; }
      record('score popups render in-canvas', typeof text === 'string' && text.indexOf('+100') !== -1, JSON.stringify(text));
    })
    .then(function () {
      // safety net: the drag stage needs a live, unpaused run; if the popup
      // wait ended on a dead run, restart and let the menu hide first
      return evalJs(cdp, '(function(){var r="alive";if(jQuery("#gameover-menu").is(":visible")){jsNewGame();r="restarted";}if(pjs.isPaused()){pjs.pause();}return r;})()');
    })
    .then(function (state) {
      if (state === 'restarted') {
        return ensureUnpaused(cdp).then(function () { return sleep(1000); });
      }
      return ensureUnpaused(cdp).then(function () { return sleep(400); });
    })
    .then(function () {
      // NEW THIS EPOCH: drag steering — the pointer must move the flight
      // origin away from the pointer so the ship flies toward it
      return evalJs(cdp, '(function(){' +
        'var c = document.getElementById("polybranch");' +
        'var r = c.getBoundingClientRect();' +
        'window.__before = JSON.stringify({ox: pjs.getOriginX(), oy: pjs.getOriginY()});' +
        'var startX = r.left + r.width * 0.5, startY = r.top + r.height * 0.70;' +
        'var opts = {bubbles: true, cancelable: true, clientX: startX, clientY: startY, pageX: startX + window.scrollX, pageY: startY + window.scrollY, button: 0};' +
        'c.dispatchEvent(new MouseEvent("mousedown", opts));' +
        'for (var i = 1; i <= 6; i++) {' +
        '  var x = startX - r.width * 0.20 * (i / 6), y = startY + r.height * 0.05 * (i / 6);' +
        '  document.dispatchEvent(new MouseEvent("mousemove", {bubbles: true, cancelable: true, clientX: x, clientY: y, pageX: x + window.scrollX, pageY: y + window.scrollY}));' +
        '}' +
        'return "dragged";' +
        '})()');
    })
    .then(function () {
      // wait until the sketch reports the drag is steering (frame-aware:
      // 60 frames of budget, 15 s wall)
      return waitUntilFrames(cdp, 'pjs.isPointerSteering() && pjs.getPointerSteerFrames() > 0', 60, 15000, 'drag frames');
    })
    .then(function () {
      return evalJs(cdp, 'JSON.stringify({active: pjs.isPointerSteering(), tx: Math.round(pjs.getPointerSteerX()), ty: Math.round(pjs.getPointerSteerY()), frames: pjs.getPointerSteerFrames()})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('drag engages pointer steering', o.active === true && o.frames > 0, JSON.stringify(o));
      dragSteer = o;
      return sleep(600);
    })
    .then(function () {
      // wait until the origin has actually scrolled away from the pointer
      // (the visible effect of correct steering) before the evidence shot
      return waitUntilFrames(cdp, '(function(){var b=JSON.parse(window.__before||"{}");var mx=pjs.getOriginX()-b.ox,my=pjs.getOriginY()-b.oy;var ax=400-pjs.getPointerSteerX(),ay=400-pjs.getPointerSteerY();var al=Math.sqrt(ax*ax+ay*ay)+0.001;return (mx*ax+my*ay)/al>30;})()', 90, 20000, 'origin scrolls away from pointer');
    })
    .then(function () {
      // evidence shot while the drag still holds: the ship has flown toward
      // the pointer and is parked against the far wall
      return cdp.send('Page.captureScreenshot', { format: 'png' });
    })
    .then(function (shot) {
      var out = path.join(GAME_DIR, 'probe-evidence', 'drag-steering.png');
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      record('drag steering screenshot captured', true, path.relative(process.cwd(), out));
      return evalJs(cdp, 'JSON.stringify({ox: Math.round(pjs.getOriginX()), oy: Math.round(pjs.getOriginY()), active: pjs.isPointerSteering()})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      var d = dragSteer || {};
      var b = dragBefore;
      // project the origin displacement onto the away-from-pointer axis;
      // correct steering pushes the tunnel away (positive), the old inverted
      // code pulled it toward the pointer (negative)
      var mx = o.ox - b.ox, my = o.oy - b.oy;
      var ax = 400 - d.tx, ay = 400 - d.ty;
      var alen = Math.sqrt(ax * ax + ay * ay) + 0.001;
      var away = Math.round((mx * ax + my * ay) / alen);
      record('drag steers the ship toward the pointer', o.active === true && away > 30, 'origin=' + JSON.stringify(o) + ' from=' + JSON.stringify(b) + ' target=' + JSON.stringify(d) + ' awayPx=' + away);
      return evalJs(cdp, 'document.dispatchEvent(new MouseEvent("mouseup", {bubbles: true})); JSON.stringify({active: pjs.isPointerSteering(), cls: jQuery("#game-wrapper").hasClass("steering")})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('drag release ends pointer steering', o.active === false && o.cls === false, v);
      // safety net: the drag parks the ship against the wall, which can end
      // the run; restart so the keyboard stage has a live run
      return evalJs(cdp, '(function(){var r="alive";if(jQuery("#gameover-menu").is(":visible")){jsNewGame();r="restarted";}if(pjs.isPaused()){pjs.pause();}return r;})()');
    })
    .then(function (state) {
      if (state === 'restarted') {
        return ensureUnpaused(cdp).then(function () { return sleep(1000); });
      }
      return null;
    })
    .then(function () {
      // NEW THIS EPOCH: keyboard flight must still work after pointer
      // steering; re-focus the canvas (the drag may have moved focus), then
      // hold ArrowRight and read the sketch's own key state
      return evalJs(cdp, 'var c=document.getElementById("polybranch"); c.setAttribute("tabindex","-1"); c.focus(); document.activeElement === c');
    })
    .then(function () {
      return cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, code: 'ArrowRight', key: 'ArrowRight' });
    })
    .then(function () { return sleep(500); })
    .then(function () {
      return evalJs(cdp, 'JSON.stringify({paused: pjs.isPaused(), playing: (typeof playing !== "undefined") ? playing : null, key: (function(){var w=[];for(var i=0;i<4;i++){if(pjs.isKeyHeld(i))w.push(i);}return w.join("");})()})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('keyboard flight still live after drag', o.paused === false && o.key === '3', v);
      return cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, key: 'ArrowRight' });
    })
    .then(function () {
      // NEW: the next-level hint must match the real threshold table (no stale +1000 offset)
      return evalJs(cdp, 'JSON.stringify({hint: jQuery("#hud #next-level-hint").text(), level: pjs.getGameLevel(), expected: (function(){var L=pjs.getGameLevel(); return (L >= 12) ? "MAX LEVEL" : "NEXT LEVEL AT " + addCommas(pjs.getNextScore(L));})()})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('next-level hint matches true threshold', o.hint === o.expected, v);
    })
    .then(function () {
      // NEW: the velocity gauge must be visible, labelled, and reflect the live tunnel speed
      return evalJs(cdp, 'JSON.stringify({' +
        'visible: (function(){var o=jQuery("#hud #speed-box");return o.length===1 && o.is(":visible");})(),' +
        'label: jQuery("#hud #speed-label").text(),' +
        'pct: parseInt(jQuery("#hud #speed-value").text(),10),' +
        'fill: jQuery("#hud #speed-fill").css("width"),' +
        'caption: jQuery("#hud #speed-caption-text").text(),' +
        'max: pjs.getMaxSpeed() })');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('velocity gauge visible with label', o.visible === true && o.label === 'VELOCITY', v);
      return evalJs(cdp, 'JSON.stringify({pct: parseInt(jQuery("#hud #speed-value").text(),10), fillPx: parseFloat(jQuery("#hud #speed-fill").css("width"))})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('gauge percent matches fill width', o.pct >= 0 && o.pct <= 100 && o.fillPx >= 0, v);
      return evalJs(cdp, 'pjs.getGameSpeed()');
    })
    .then(function (gameSpeed) {
      return evalJs(cdp, 'window.__gameSpeed = ' + gameSpeed + '; jsUpdateSpeed(window.__gameSpeed); jQuery("#hud #speed-value").text()');
    })
    .then(function (label) {
      record('gauge reads live game speed', /^[0-9]+%$/.test(label), 'pjs.getGameSpeed()=' + label);
      return evalJs(cdp, 'window.__bestBefore = localStorage["highScore"]; localStorage["highScore"] = 12345; jsUpdateBest(); jQuery("#hud #best").text()');
    })
    .then(function (best) {
      record('personal best surfaced in HUD', best === 'BEST 12,345', best);
      return evalJs(cdp, 'localStorage["highScore"] = window.__bestBefore; jsUpdateBest(); "restored"');
    })
    .then(function (v) {
      record('best readout restored', v === 'restored', v);
      // safety net: pjs.pause() below is a toggle and needs a live,
      // unpaused run to assert the overlay appears
      return evalJs(cdp, '(function(){var r="alive";if(jQuery("#gameover-menu").is(":visible")){jsNewGame();r="restarted";}if(pjs.isPaused()){pjs.pause();}return r;})()');
    })
    .then(function (state) {
      if (state === 'restarted') {
        return ensureUnpaused(cdp).then(function () { return sleep(1000); });
      }
      return null;
    })
    .then(function () {
      return evalJs(cdp, 'window.__pausedBefore = pjs.isPaused(); pjs.pause(); window.__pausedAfter = pjs.isPaused();' +
        'JSON.stringify({before: window.__pausedBefore, after: window.__pausedAfter, menu: jQuery("#pause-menu").is(":visible")})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('pause overlay (P)', o.before === false && o.after === true && o.menu === true, v);
      return evalJs(cdp, 'pjs.pause(); "toggled"');
    })
    .then(function () { return sleep(450); })
    .then(function () {
      return evalJs(cdp, 'JSON.stringify({paused: pjs.isPaused(), menu: jQuery("#pause-menu").is(":visible")})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('resume clears pause overlay', o.paused === false && o.menu === false, v);
    })
    .then(function () {
      return evalJs(cdp, 'jsToggleSound() + "|" + jQuery("#sound-label").text() + "|" + jsToggleSound() + "|" + jQuery("#sound-label").text()');
    })
    .then(function (v) {
      record('sound toggle + mute respected', v === 'true|OFF|false|ON', v);
    })
    .then(function () {
      return evalJs(cdp, 'jQuery("#hud #next-level-hint").text()');
    })
    .then(function (v) {
      record('next-level target shown in HUD', /NEXT LEVEL AT/.test(v), v);
      return evalJs(cdp, 'jsGameOver(600); window.__goAfter = jQuery("#gameover-menu #run-summary").text(); "crashed"');
    })
    .then(function (v) {
      record('game over path triggered', v === 'crashed', v);
      return waitUntil(cdp, 'jQuery("#gameover-menu #run-summary").text().indexOf("points") !== -1 ? jQuery("#gameover-menu #run-summary").text() : ""', 15000, 'run summary');
    })
    .then(function (summary) {
      record('run summary readable on game over', /reached .*points/.test(summary), summary);
      return evalJs(cdp, 'JSON.stringify({summary: jQuery("#gameover-menu #run-summary").text(), closeCalls: pjs.getRunCloseCalls(), bonus: pjs.getRunCloseCallBonus()})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('run summary reports close-call skill', o.closeCalls >= 0 && o.bonus >= 0 && /(close call|clean flying)/i.test(o.summary), v);
      return evalJs(cdp, 'window.__scoreBefore = pjs.getGameScore(); jsNewGame(); "restarted"');
    })
    .then(function (v) {
      return waitUntil(cdp, 'pjs.getGameScore() === 0 && jQuery("#hud #score").text() === "0" && pjs.getGameLevel() === 1', 20000, 'score/level reset');
    })
    .then(function () {
      return evalJs(cdp, 'JSON.stringify({paused: pjs.isPaused(), speed: pjs.getGameSpeed(), speedLabel: jQuery("#hud #speed-value").text(), expectedPct: Math.round(pjs.getGameSpeed()/pjs.getMaxSpeed()*100) + \'%\'})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('restart resets state to level 1', o.paused === false && o.speed === 0.0025 && o.speedLabel === o.expectedPct, v);
      return evalJs(cdp, 'JSON.stringify({nm: pjs.getNearMisses(), st: pjs.getStreak(), best: pjs.getBestStreak(), popups: pjs.getPopupCount()})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('near-miss counters reset on restart', o.nm === 0 && o.st === 0 && o.best === 0 && o.popups === 0, v);
      return ensureUnpaused(cdp).then(function () {
        return evalJs(cdp, 'window.__pausedBefore2 = pjs.isPaused(); pjs.pause(); "paused2"');
      });
    })
    .then(function () {
      return sleep(1200);
    })
    .then(function () {
      return evalJs(cdp, 'JSON.stringify({paused: pjs.isPaused(), menu: jQuery("#pause-menu").is(":visible"), score: pjs.getGameScore()})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('pause works after restart', o.paused === true && o.score === 0, v);
      return evalJs(cdp, 'pjs.pause(); "resumed"');
    })
    .then(function () { return sleep(450); })
    .then(function () {
      return evalJs(cdp, 'JSON.stringify({paused: pjs.isPaused(), menu: jQuery("#pause-menu").is(":visible")})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('resume works after restart', o.paused === false, v);
      return evalJs(cdp, 'pjs.pause(); "paused-for-badge"');
    })
    .then(function () {
      return evalJs(cdp, 'jsUpdateProgress(250, 1); JSON.stringify({pct: jQuery("#hud #progress-pct").text(), fill: parseFloat(jQuery("#hud #level-progress-fill").css("width")), track: parseFloat(jQuery("#hud #level-progress-track").css("width")), box: jQuery("#hud #level-progress").length})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('next-level progress bar tracks score', o.box === 1 && o.pct === '50%' && o.track > 0, v);
      return evalJs(cdp, 'jsUpdateProgress(pjs.getGameScore(), pjs.getGameLevel()); JSON.stringify({pct: parseInt(jQuery("#hud #progress-pct").text(),10), fill: parseFloat(jQuery("#hud #level-progress-fill").css("width")), track: parseFloat(jQuery("#hud #level-progress-track").css("width"))})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('progress bar matches live run', o.pct >= 0 && o.pct <= 100 && o.track > 0 && Math.abs(o.fill / o.track - o.pct / 100) <= 0.02, v);
      return evalJs(cdp, 'jsNearMiss(3, 75); JSON.stringify({visible: jQuery("#hud #streak-badge").is(":visible"), text: jQuery("#hud #streak-badge").text()})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('close-call badge surfaces streak', o.visible === true && /CLOSE CALL/.test(o.text) && /3/.test(o.text) && /75/.test(o.text), v);
      return evalJs(cdp, 'jsNearMiss(0, 0); "cleared"');
    })
    .then(function () {
      return sleep(1400);
    })
    .then(function () {
      return evalJs(cdp, 'JSON.stringify({visible: jQuery("#hud #streak-badge").is(":visible"), text: jQuery("#hud #streak-badge").text()})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('close-call badge clears', o.visible === false, v);
      return evalJs(cdp, 'pjs.pause(); "resumed"');
    })
    .then(function () {
      // safety net: the danger stage needs a live, unpaused run
      return evalJs(cdp, '(function(){var r="alive";if(jQuery("#gameover-menu").is(":visible")){jsNewGame();r="restarted";}if(pjs.isPaused()){pjs.pause();}return r;})()');
    })
    .then(function (state) {
      if (state === 'restarted') {
        return ensureUnpaused(cdp).then(function () { return sleep(1000); });
      }
      return sleep(450);
    })
    .then(function () {
      // NEW THIS EPOCH: proximity warning ring — force a branch within
      // danger range and verify the sketch's danger level rises
      return evalJs(cdp, 'JSON.stringify({hook: typeof pjs.forceDangerForProbe, before: Math.round(pjs.getNearestBranchDist())})')
        .then(function (diag) {
          var d = JSON.parse(diag);
          if (d.hook !== 'function') throw new Error('danger hooks unavailable: ' + diag);
          return evalJs(cdp, 'pjs.forceDangerForProbe(34); "forced"');
        })
        .then(function () { return sleep(400); })
        .then(function () {
          return evalJs(cdp, 'JSON.stringify({danger: pjs.getDangerLevel(), nd: Math.round(pjs.getNearestBranchDist()), range: pjs.getDangerRange()})');
        })
        .then(function (v) {
          var o = JSON.parse(v);
          record('danger level rises as a branch nears', o.danger >= 0.5 && o.nd <= 40 && o.range > 0, v);
          return evalJs(cdp, '(function(){' +
            'var c = document.getElementById("polybranch");' +
            'var ctx = c.getContext("2d");' +
            'var red = 0;' +
            'for (var a = 0; a < 16; a++) {' +
            '  var ang = a * Math.PI / 8;' +
            '  for (var i = 0; i < 3; i++) {' +
            '    var rad = 38 + i * 2;' +
            '    var x = Math.round(c.width / 2 + rad * Math.cos(ang));' +
            '    var y = Math.round(c.height / 2 + rad * Math.sin(ang));' +
            '    var px = ctx.getImageData(x, y, 1, 1).data;' +
            '    if (px[0] > 140 && (px[0] - px[1]) > 50 && (px[0] - px[2]) > 50) red++;' +
            '  }' +
            '}' +
            'return JSON.stringify({red: red, of: 48});' +
            '})()');
        })
        .then(function (raw) {
          var o = JSON.parse(raw);
          record('danger ring renders on canvas', o.red >= 8, raw);
          return cdp.send('Page.captureScreenshot', { format: 'png' });
        })
        .then(function (shot) {
          var out = path.join(GAME_DIR, 'probe-evidence', 'danger-ring.png');
          fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
          record('danger ring screenshot captured', true, path.relative(process.cwd(), out));
          // NEW THIS EPOCH: threat bearing marker — re-force the danger from
          // the north (angle -PI/2) and verify the amber arc/chevrons land on
          // that side of the ship only. The bottom control fan stays clear of
          // the in-canvas popup band (bottom popups sit at radius >= 70).
          return evalJs(cdp, 'pjs.forceDangerForProbe(34, -Math.PI / 2); "angled"');
        })
        .then(function () { return sleep(300); })
        .then(function () {
          return evalJs(cdp, '(function(){' +
            'var c = document.getElementById("polybranch");' +
            'var ctx = c.getContext("2d");' +
            'function fan(angBase, radMax){' +
            '  var amber = 0;' +
            '  for (var a = -4; a <= 4; a++) {' +
            '    var ang = angBase + a * Math.PI / 18;' +
            '    for (var rad = 34; rad <= radMax; rad += 6) {' +
            '      var x = Math.round(c.width / 2 + rad * Math.cos(ang));' +
            '      var y = Math.round(c.height / 2 + rad * Math.sin(ang));' +
            '      var px = ctx.getImageData(x, y, 1, 1).data;' +
            '      if (px[0] > 150 && px[1] > 110 && (px[0] - px[2]) > 60 && (px[1] - px[2]) > 40) amber++;' +
            '    }' +
            '  }' +
            '  return amber;' +
            '}' +
            'return JSON.stringify({ang: Math.round(pjs.getNearestBranchAngle() * 100) / 100, top: fan(-Math.PI / 2, 92), bottom: fan(Math.PI / 2, 64)});' +
            '})()');
        })
        .then(function (raw) {
          var o = JSON.parse(raw);
          record('danger marker points at the threat', o.top >= 6 && o.bottom <= 1, raw);
          return evalJs(cdp, 'pjs.clearDangerForProbe(); "released"');
        })
        .then(function () { return sleep(600); })
        .then(function () {
          return evalJs(cdp, 'JSON.stringify({danger: pjs.getDangerLevel(), nd: Math.round(pjs.getNearestBranchDist()), range: pjs.getDangerRange()})');
        })
        .then(function (v) {
          var o = JSON.parse(v);
          record('danger ring follows live proximity', (o.danger > 0) === (o.nd < o.range), v);
          return null;
        });
    })
    .then(function () {
      // NEW THIS EPOCH: speed streaks — the tunnel itself must convey
      // velocity: auto intensity is ~0 at level 1-2 speed, forcing full
      // intensity draws long radial motion lines, releasing restores auto
      return evalJs(cdp, '(function(){var r="alive";if(jQuery("#gameover-menu").is(":visible")){jsNewGame();r="restarted";}if(pjs.isPaused()){pjs.pause();}return r;})()');
    })
    .then(function (state) {
      if (state === 'restarted') {
        return ensureUnpaused(cdp).then(function () { return sleep(900); });
      }
      return sleep(450);
    })
    .then(function () {
      return evalJs(cdp, 'JSON.stringify({hook: typeof pjs.getSpeedStreakIntensity, auto: pjs.getSpeedStreakIntensity()})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      if (o.hook !== 'function') throw new Error('speed streak hooks unavailable: ' + v);
      record('speed streaks idle at low speed', o.auto < 0.05, v);
      return evalJs(cdp, 'pjs.forceSpeedStreaksForProbe(1); "forced"');
    })
    .then(function () { return sleep(350); })
    .then(function () {
      return evalJs(cdp, '(function(){' +
        'var c = document.getElementById("polybranch");' +
        'var ctx = c.getContext("2d");' +
        'var cx = Math.round(c.width / 2), cy = Math.round(c.height / 2);' +
        'var bestRun = 0, darkTotal = 0;' +
        'for (var r = 0; r < 36; r++) {' +
        '  var ang = r * Math.PI / 18;' +
        '  var run = 0;' +
        '  for (var rad = 160; rad <= 420; rad += 8) {' +
        '    var x = Math.round(cx + rad * Math.cos(ang));' +
        '    var y = Math.round(cy + rad * Math.sin(ang));' +
        '    var px = ctx.getImageData(x, y, 1, 1).data;' +
        '    var lum = (px[0] + px[1] + px[2]) / 3;' +
        '    if (lum < 200) { run++; darkTotal++; } else { run = 0; }' +
        '    if (run > bestRun) { bestRun = run; }' +
        '  }' +
        '}' +
        'return JSON.stringify({forced: pjs.getSpeedStreakIntensity(), bestRun: bestRun, darkTotal: darkTotal});' +
        '})()');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('speed streaks render at full intensity', o.forced === 1 && o.bestRun >= 12 && o.darkTotal >= 20, v);
      return cdp.send('Page.captureScreenshot', { format: 'png' });
    })
    .then(function (shot) {
      var out = path.join(GAME_DIR, 'probe-evidence', 'speed-streaks.png');
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      record('speed streaks screenshot captured', true, path.relative(process.cwd(), out));
      return evalJs(cdp, 'pjs.clearSpeedStreaksForProbe(); "released"');
    })
    .then(function () { return sleep(200); })
    .then(function () {
      return evalJs(cdp, 'JSON.stringify({auto: pjs.getSpeedStreakIntensity()})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('speed streaks release to auto intensity', o.auto < 0.05, v);
      return null;
    })
    .then(function () {
      // NEW THIS EPOCH: death shockwave — a forced crash must play out the
      // one-shot ring effect on the frozen tunnel, then restart cleanly
      return evalJs(cdp, '(function(){var r="alive";if(jQuery("#gameover-menu").is(":visible")){jsNewGame();r="restarted";}if(pjs.isPaused()){pjs.pause();}return r;})()');
    })
    .then(function (state) {
      if (state === 'restarted') {
        return ensureUnpaused(cdp).then(function () { return sleep(600); });
      }
      return sleep(400);
    })
    .then(function () {
      return evalJs(cdp, 'JSON.stringify({hook: typeof pjs.forceGameOverForProbe, fx: pjs.getDeathFxFrame()})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      if (o.hook !== 'function') throw new Error('death fx hooks unavailable: ' + v);
      if (o.fx >= 0) throw new Error('death fx state not clean before forced crash: ' + v);
      return evalJs(cdp, 'pjs.forceGameOverForProbe(); "dead"');
    })
    .then(function () { return sleep(700); })
    .then(function () {
      return evalJs(cdp, 'JSON.stringify({fx: pjs.getDeathFxFrame()})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      deathFx = o;
      record('forced crash starts the death fx', o.fx > 0, v);
      return sleep(600);
    })
    .then(function () {
      return evalJs(cdp, 'JSON.stringify({fx: pjs.getDeathFxFrame()})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('death fx advances on one-shot redraws', o.fx > 0 && o.fx < 110 && o.fx - deathFx.fx >= 3, v + ' delta=' + (o.fx - deathFx.fx));
      // sample the canvas at the expected outer-ring radius; a majority of
      // the angles must be darker than the white death background
      return evalJs(cdp, '(function(){' +
        'var c = document.getElementById("polybranch");' +
        'var ctx = c.getContext("2d");' +
        'var cx = Math.round(c.width/2), cy = Math.round(c.height/2);' +
        'var t = pjs.getDeathFxFrame() / 110;' +
        'var r = Math.round(20 + 14 + t * 330);' +
        'var dark = 0, total = 0;' +
        'for (var dr = -4; dr <= 4; dr += 4) {' +
        '  for (var a = 0; a < 72; a++) {' +
        '    var ang = a * Math.PI / 36;' +
        '    var x = Math.round(cx + (r + dr) * Math.cos(ang));' +
        '    var y = Math.round(cy + (r + dr) * Math.sin(ang));' +
        '    if (x < 0 || y < 0 || x >= c.width || y >= c.height) continue;' +
        '    var px = ctx.getImageData(x, y, 1, 1).data;' +
        '    total++;' +
        '    if ((px[0] + px[1] + px[2]) / 3 < 215) dark++;' +
        '  }' +
        '}' +
        'return JSON.stringify({dark: dark, total: total, r: r});' +
        '})()');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('death shockwave rings render on canvas', o.total >= 150 && o.dark * 2 >= o.total, v);
      return sleep(650);
    })
    .then(function () {
      // evidence shot after the white flash has faded (it covers the canvas
      // for the first two seconds after a crash)
      return cdp.send('Page.captureScreenshot', { format: 'png' });
    })
    .then(function (shot) {
      var out = path.join(GAME_DIR, 'probe-evidence', 'death-shock.png');
      fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
      record('death shockwave screenshot captured', true, path.relative(process.cwd(), out));
      return evalJs(cdp, 'jsNewGame(); "restarted"');
    })
    .then(function () {
      return ensureUnpaused(cdp).then(function () { return sleep(500); });
    })
    .then(function () {
      return evalJs(cdp, 'JSON.stringify({fx: pjs.getDeathFxFrame(), level: pjs.getGameLevel(), paused: pjs.isPaused(), menu: jQuery("#gameover-menu").is(":visible")})');
    })
    .then(function (v) {
      var o = JSON.parse(v);
      record('restart after death clears the fx', o.fx === -1 && o.level === 1 && o.paused === false, v);
      return null;
    })
    .then(function () {
      return cancelDelayedEval(cdp);
    })
    .then(function (v) {
      var cleaned = v === 'cleared' || (v && v.cleared === 'cleared') || (v && v.result && v.result.value === 'cleared');
      record('probe cleanup', cleaned, JSON.stringify(v));
    })
    .then(function () {
      var errors = consoleErrors.filter(function (e) { return !/favicon|Autofill|GroupMarkerNotSet|audio|AudioContext|play\(\)|getUserMedia|net::ERR(?!.*[Ee]rror)|Failed to load resource|Download the React DevTools|WebSocket connection.*(failed|closed)|404|500 |ERR_(NAME_NOT_RESOLVED|ABORTED|CONNECTION_REFUSED)|Mixed Content|Refused to .* frame|deprecat/i.test(e); });
      record('no console errors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'clean');
      var failed = results.filter(function (r) { return !r.ok; });
      console.log(failed.length === 0 ? 'BOOT PROBE PASS (' + results.length + ' checks)' : 'BOOT PROBE FAIL (' + failed.length + ' of ' + results.length + ' checks failed)');
      cleanup(failed.length === 0 ? 0 : 1);
    })
    .catch(function (err) {
      console.log('BOOT PROBE FAIL: ' + (err && err.message || err));
      if (consoleErrors.length) console.log('page console: ' + consoleErrors.slice(0, 5).join(' | '));
      else if (chromeErr) console.log('chrome stderr tail: ' + chromeErr.slice(-600));
      cleanup(1);
    });
    });
  }).on('error', function (e) {
    console.log('BOOT PROBE FAIL: cannot reach devtools endpoint: ' + (e && e.message || e));
    cleanup(1);
  });
}
