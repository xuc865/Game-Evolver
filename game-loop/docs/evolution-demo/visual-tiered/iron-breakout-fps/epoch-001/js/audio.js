/* =========================================================================
   钢铁突围：程序化音效引擎（Web Audio API）
   全部声音由振荡器 / 噪声缓冲实时合成，无外部音频文件、无网络请求。
   全局只暴露 window.SFX，对其他脚本零依赖；任何方法在未初始化、
   被静音或环境不支持时都安全地直接返回，绝不抛出异常。
   ========================================================================= */
(function () {
  "use strict";

  var context = null;
  var master = null;
  var muted = false;
  var unlocked = false;
  var events = 0;
  var alarmTimer = null;
  var alarmOn = false;

  function supported() {
    return typeof window !== "undefined" &&
      (typeof window.AudioContext === "function" ||
        typeof window.webkitAudioContext === "function");
  }

  function now() {
    return context ? context.currentTime : 0;
  }

  /* 一个带包络的增益节点：attack 秒内升到 peak，再在 decay 秒内衰减到 0。 */
  function envelope(peak, attack, decay, startAt) {
    var gain = context.createGain();
    var t = startAt;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(peak, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    gain.connect(master);
    return gain;
  }

  /* 短噪声缓冲，供枪声 / 爆炸 / 机械声复用。 */
  var noiseBuffer = null;
  function getNoise() {
    if (noiseBuffer) return noiseBuffer;
    var length = Math.floor(context.sampleRate * 0.5);
    noiseBuffer = context.createBuffer(1, length, context.sampleRate);
    var data = noiseBuffer.getChannelData(0);
    for (var i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return noiseBuffer;
  }

  function playNoise(peak, attack, decay, filterType, freq, q) {
    var source = context.createBufferSource();
    source.buffer = getNoise();
    var filter = context.createBiquadFilter();
    filter.type = filterType || "lowpass";
    filter.frequency.value = freq || 1200;
    filter.Q.value = q || 0.8;
    var gain = envelope(peak, attack, decay, now());
    source.connect(filter);
    filter.connect(gain);
    source.start(now());
    source.stop(now() + attack + decay + 0.05);
  }

  function playTone(type, startFreq, endFreq, peak, attack, decay) {
    var osc = context.createOscillator();
    osc.type = type;
    var t = now();
    osc.frequency.setValueAtTime(startFreq, t);
    if (endFreq && endFreq !== startFreq) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(20, endFreq), t + attack + decay);
    }
    var gain = envelope(peak, attack, decay, t);
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
  }

  function emit() {
    events++;
  }

  /* 每种武器一份音色参数：噪声亮度 + 低频冲击。 */
  var WEAPON_SOUNDS = {
    "机枪": { noise: 0.30, decay: 0.09, freq: 2600, thump: 150 },
    "手枪": { noise: 0.34, decay: 0.13, freq: 3400, thump: 190 },
    "狙击枪": { noise: 0.42, decay: 0.30, freq: 1500, thump: 85 },
    "匕首": { noise: 0.10, decay: 0.16, freq: 900, thump: 0 },
    "火箭弹": { noise: 0.40, decay: 0.24, freq: 700, thump: 70 }
  };

  var sfx = {

    /* ---- 生命周期 ---- */
    init: function () {
      if (context || !supported()) return;
      var Ctor = window.AudioContext || window.webkitAudioContext;
      try {
        context = new Ctor();
      } catch (err) {
        context = null;
        return;
      }
      master = context.createGain();
      master.gain.value = 0.5;
      master.connect(context.destination);
      unlocked = true;
      if (context.state === "suspended" && context.resume) {
        context.resume();
      }
    },

    resume: function () {
      if (context && context.state === "suspended" &&
        context.resume && context.resume.call) {
        try { context.resume(); } catch (err) { /* 保持安静 */ }
      }
    },

    /* ---- 射击 ---- */
    shot: function (weaponName) {
      if (!context || muted) return;
      var sound = WEAPON_SOUNDS[weaponName] || WEAPON_SOUNDS["机枪"];
      playNoise(sound.noise, 0.004, sound.decay, "bandpass", sound.freq, 1.2);
      if (sound.thump > 0) {
        playTone("sine", sound.thump * 2.2, sound.thump * 0.6,
          0.24, 0.004, sound.decay * 0.8);
      }
      emit();
    },

    /* ---- 命中反馈：部位不同音高不同 ---- */
    hit: function (zone) {
      if (!context || muted) return;
      var freq = zone === "head" ? 1720 : zone === "limb" ? 820 : 1180;
      var peak = zone === "head" ? 0.20 : 0.13;
      playTone("triangle", freq, freq * 0.7, peak, 0.002, 0.07);
      emit();
    },

    kill: function () {
      if (!context || muted) return;
      playTone("square", 620, 880, 0.12, 0.004, 0.10);
      playTone("sine", 310, 440, 0.10, 0.004, 0.14);
      emit();
    },

    streak: function (level) {
      if (!context || muted) return;
      var step = Math.min(8, Math.max(1, level || 1));
      playTone("triangle", 520 + step * 90, 780 + step * 110,
        0.14, 0.006, 0.16);
      emit();
    },

    /* 连杀层级变化提示：热 / 炽热 */
    streakFeedback: function (hot, blazing) {
      if (!context || muted) return;
      if (blazing) playTone("sawtooth", 300, 640, 0.10, 0.01, 0.22);
      else if (hot) playTone("triangle", 420, 560, 0.08, 0.01, 0.14);
      else return;
      emit();
    },

    /* ---- 换弹：两段机械声 ---- */
    reload: function () {
      if (!context || muted) return;
      playNoise(0.16, 0.004, 0.06, "bandpass", 1500, 2);
      var self = this;
      window.setTimeout(function () {
        if (context && !muted) playNoise(0.12, 0.004, 0.05, "bandpass", 900, 2);
      }, 130);
      emit();
    },

    reloadDone: function () {
      if (!context || muted) return;
      playNoise(0.14, 0.003, 0.05, "bandpass", 2100, 2.4);
      playTone("square", 880, 660, 0.08, 0.003, 0.07);
      emit();
    },

    /* ---- 武器切换 ---- */
    swap: function () {
      if (!context || muted) return;
      playNoise(0.10, 0.003, 0.05, "highpass", 1800, 1);
      playTone("square", 520, 700, 0.07, 0.003, 0.06);
      emit();
    },

    /* ---- 补给 ---- */
    pickup: function () {
      if (!context || muted) return;
      playTone("sine", 660, 990, 0.13, 0.006, 0.13);
      playTone("sine", 990, 1320, 0.09, 0.10, 0.12);
      emit();
    },

    /* ---- 爆炸：噪声 + 低频下坠 ---- */
    explosion: function () {
      if (!context || muted) return;
      playNoise(0.46, 0.006, 0.55, "lowpass", 420, 0.7);
      playTone("sine", 130, 38, 0.34, 0.008, 0.5);
      emit();
    },

    hurt: function () {
      if (!context || muted) return;
      playNoise(0.20, 0.004, 0.14, "lowpass", 700, 0.9);
      playTone("sawtooth", 220, 90, 0.14, 0.004, 0.16);
      emit();
    },

    /* ---- 濒死警报：心跳式低频循环 ---- */
    alarm: function (on) {
      var want = Boolean(on);
      if (want === alarmOn) return;
      alarmOn = want;
      if (!want) {
        if (alarmTimer !== null) {
          window.clearInterval(alarmTimer);
          alarmTimer = null;
        }
        return;
      }
      if (!context || muted) return;
      var beat = function () {
        if (!context || muted || !alarmOn) return;
        playTone("sine", 96, 60, 0.30, 0.01, 0.20);
        playTone("sine", 96, 60, 0.22, 0.16, 0.18);
        events++;
      };
      beat();
      alarmTimer = window.setInterval(beat, 900);
    },

    /* ---- 界面 ---- */
    uiClick: function () {
      if (!context || muted) return;
      playTone("square", 760, 980, 0.08, 0.002, 0.05);
      emit();
    },

    gameOver: function () {
      if (!context || muted) return;
      playTone("sawtooth", 340, 82, 0.20, 0.02, 0.85);
      playTone("triangle", 220, 55, 0.14, 0.02, 1.0);
      emit();
    },

    levelClear: function () {
      if (!context || muted) return;
      playTone("triangle", 520, 780, 0.15, 0.01, 0.18);
      var self = this;
      window.setTimeout(function () {
        if (context && !muted) playTone("triangle", 660, 990, 0.15, 0.01, 0.22);
      }, 140);
      window.setTimeout(function () {
        if (context && !muted) playTone("triangle", 780, 1180, 0.16, 0.01, 0.30);
      }, 280);
      emit();
    },

    /* ---- 静音门：所有事件入口统一检查 ---- */
    setMuted: function (value) {
      muted = Boolean(value);
      if (muted && alarmTimer !== null) {
        window.clearInterval(alarmTimer);
        alarmTimer = null;
      }
      if (!muted && alarmOn && context) {
        this.alarm(false);
        this.alarm(true);
      }
    },

    isMuted: function () {
      return muted;
    },

    getStats: function () {
      return {
        created: Boolean(context),
        contextState: context ? context.state : "none",
        muted: muted,
        events: events,
        alarmActive: alarmOn && alarmTimer !== null
      };
    },

    dispose: function () {
      if (alarmTimer !== null) {
        window.clearInterval(alarmTimer);
        alarmTimer = null;
      }
      alarmOn = false;
      if (context && context.close) {
        try { context.close(); } catch (err) { /* 忽略 */ }
      }
      context = null;
      master = null;
      noiseBuffer = null;
      unlocked = false;
    }
  };

  window.SFX = sfx;
})();
