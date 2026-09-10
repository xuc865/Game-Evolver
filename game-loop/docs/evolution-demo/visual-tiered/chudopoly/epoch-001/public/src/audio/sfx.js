// audio/sfx.js — the bank. Owner: audio/ (§1).
//
// A CARD ROOM, NOT AN ARCADE. Every voice here is built out of oscillators,
// three shared noise buffers and envelopes (§0.3: zero binary assets, ever), and
// the vocabulary is §7's: paper, felt, chips, a bugle in the next hangar. Nothing
// is a video-game "blip" — the loudest thing in the bank is a klaxon and it fires
// twice a game.
//
// SHAPE OF A VOICE. Each entry is `fn(g, t0, o)`:
//   g  — the graph handle from engine.js: { ctx, sfxBus, uiBus, bedBus, reverb,
//        noise{white,pink,brown}, rng }.
//   t0 — an ABSOLUTE context time. The same code path therefore serves realtime
//        playback and the OfflineAudioContext render in tools/audiotest.mjs;
//        there is no second implementation to drift.
//   o  — { mine, big, gain, pan, pitch }, already resolved by engine.js. §7's
//        mine/theirs treatment lives entirely in `head()` below, so no sound can
//        forget it.
//
// Voice budget and retrigger floors are NOT in this file — engine.js claims the
// budget before it calls in, using a static duration/weight table. A bank
// function that has been called may assume it is allowed to make noise.

import {
  semis, clamp, perc, swell, glide, glide3, EPS,
  LADDER_ROOT, LADDER_DEGREES,
} from './dsp.js';

/* ── primitives ────────────────────────────────────────────────────────── */

function osc(g, type, freq, t0, tEnd) {
  const o = g.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(freq, 0.01), t0);
  o.start(t0);
  o.stop(tEnd);
  return o;
}

/**
 * A slice of one of the three shared buffers, at a seeded random offset. The
 * offset is what stops five dealt cards sounding like one click repeated, and
 * it is free: the buffers are allocated once when the graph is built.
 */
function noise(g, kind, t0, dur, rate = 1) {
  const s = g.ctx.createBufferSource();
  const buf = g.noise[kind] || g.noise.white;
  s.buffer = buf;
  s.playbackRate.value = rate;
  const maxOff = Math.max(0, buf.duration - dur * rate - 0.01);
  s.start(t0, g.rng() * maxOff, dur * rate + 0.01);
  s.stop(t0 + dur + 0.02);
  return s;
}

function gain(g, v = 0) {
  const n = g.ctx.createGain();
  n.gain.value = v;
  return n;
}

function filt(g, type, freq, q = 1) {
  const f = g.ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = Math.max(10, freq);
  f.Q.value = q;
  return f;
}

function panner(g, x) {
  const p = g.ctx.createStereoPanner();
  p.pan.value = clamp(x, -1, 1);
  return p;
}

/** Connect a node to the reverb send at `amount` (0..1). */
function send(g, node, amount) {
  if (!g.reverb || amount <= 0) return;
  const s = gain(g, amount);
  node.connect(s);
  s.connect(g.reverb);
}

/**
 * The head of every voice, and the ONLY place §7's mine/theirs treatment lives.
 *
 *   mine   → unity gain, dead centre, no extra filtering.
 *   theirs → -6dB (engine.js folds that into o.gain), pushed off-centre, and a
 *            5.2kHz lowpass so it sits BEHIND yours instead of merely quieter.
 *            Detuning is o.pitch, applied by each voice to its own frequencies.
 *
 * The lowpass and panner are only allocated for other players' sounds, so the
 * common case (your own card) costs one GainNode.
 */
function head(g, o, wet = 0, bus = null) {
  const h = gain(g, o.gain);
  const target = bus || g.sfxBus;
  if (o.mine) {
    h.connect(target);
    if (wet > 0) send(g, h, wet);
    return h;
  }
  const lp = filt(g, 'lowpass', 5200, 0.7);
  const p = panner(g, o.pan);
  h.connect(lp);
  lp.connect(p);
  p.connect(target);
  if (wet > 0) send(g, p, wet);
  return h;
}

/** Free the chain once the tail has rung out. Insurance against graph creep. */
function autoFree(src, node) {
  src.onended = () => {
    try { node.disconnect(); } catch { /* already torn down — the state we wanted */ }
  };
}

/** A pitched frequency with the other-player detune applied. */
function f(o, hz) { return hz * o.pitch; }

/* ── shared shapes ─────────────────────────────────────────────────────── */

/**
 * The click that makes a card sound like card stock rather than a drum. 2ms of
 * highpassed white noise; used by every landing, flip and pickup.
 */
function tick(g, dest, t0, amp, hp = 2800, dur = 0.02) {
  const tg = gain(g, 0);
  const h = filt(g, 'highpass', hp, 0.7);
  const n = noise(g, 'white', t0, dur);
  n.connect(h); h.connect(tg); tg.connect(dest);
  perc(tg.gain, t0, amp, 0.001, dur * 0.9);
  autoFree(n, h);
  return tg;
}

/** A short bandpassed noise burst — the riffle's grain and the swish's body. */
function burst(g, dest, t0, dur, centre, q, amp, rate = 1, kind = 'white') {
  const bg = gain(g, 0);
  const bp = filt(g, 'bandpass', centre, q);
  const n = noise(g, kind, t0, dur, rate);
  n.connect(bp); bp.connect(bg); bg.connect(dest);
  perc(bg.gain, t0, amp, 0.0015, dur * 0.85);
  autoFree(n, bp);
  return bp;
}

/** A body thump: a sine that falls. Card weight, table knocks, dull denials. */
function thump(g, dest, t0, from, to, amp, dur) {
  const tg = gain(g, 0);
  const o = osc(g, 'sine', from, t0, t0 + dur + 0.02);
  glide(o.frequency, t0, from, to, dur * 0.8);
  o.connect(tg); tg.connect(dest);
  perc(tg.gain, t0, amp, 0.004, dur);
  return tg;
}

/* ══ THE BANK ══════════════════════════════════════════════════════════════
 *
 * Order below is the §7 vocabulary order: the table, then money, then reward,
 * then the sour half, then the turn, then the endgame.
 */

export const BANK = Object.freeze({

  /* ── the table ──────────────────────────────────────────────────────── */

  /**
   * Riffle: a burst TRAIN, not one noise hit. 18 grains over 380ms with the
   * spacing tightening 34ms -> 15ms, which is what a thumb release actually
   * does, plus a low body under it and the square-up tap at the end.
   */
  shuffle_riffle(g, t0, o) {
    const h = head(g, o, 0.22);
    let t = t0;
    let dt = 0.034;
    for (let i = 0; i < 18; i++) {
      const c = 1500 + g.rng() * 2200;
      burst(g, h, t, 0.018, c, 5 + g.rng() * 3, 0.075 + g.rng() * 0.03, 0.9 + g.rng() * 0.35);
      t += dt;
      dt = Math.max(0.015, dt * 0.94);
    }
    // The stack as a whole: a soft low sweep so the train has a body.
    const bg = gain(g, 0);
    const lp = filt(g, 'lowpass', 700, 0.8);
    const n = noise(g, 'pink', t0, 0.42);
    n.connect(lp); lp.connect(bg); bg.connect(h);
    glide(lp.frequency, t0, 950, 320, 0.4);
    swell(bg.gain, t0, 0.1, 0.05, 0.12, 0.24);
    autoFree(n, lp);
    // Square-up: the deck tapped level on the table.
    thump(g, h, t + 0.03, 200, 90, 0.16, 0.1);
    tick(g, h, t + 0.03, 0.09, 2400);
  },

  /** Card slide: paper crossing felt. Bandpass sweeps up as it leaves the hand. */
  card_slide(g, t0, o) {
    const h = head(g, o, 0.1);
    const bg = gain(g, 0);
    const bp = filt(g, 'bandpass', 1400, 0.9);
    const hp = filt(g, 'highpass', 420, 0.7);
    const n = noise(g, 'pink', t0, 0.12, 1.1);
    n.connect(hp); hp.connect(bp); bp.connect(bg); bg.connect(h);
    glide(bp.frequency, t0, f(o, 760), f(o, 2500), 0.085);
    swell(bg.gain, t0, o.big ? 0.16 : 0.115, 0.012, 0.012, 0.08);
    autoFree(n, hp);
  },

  /**
   * Snap-down: the §7 "thump + click transient". `big` is the only weight axis —
   * a stolen property lands harder than a discard, and the cue channel is what
   * knows which is which (anim/cues.js).
   */
  card_snap(g, t0, o) {
    const w = o.big ? 1.55 : 1;
    const h = head(g, o, 0.13);
    thump(g, h, t0, f(o, 158), f(o, 68), 0.17 * w, 0.11);
    // Felt: a wide, dull mid burst. This is what stops it reading as a kick drum.
    burst(g, h, t0, 0.055, f(o, 260), 1.2, 0.1 * w, 1, 'pink');
    tick(g, h, t0, 0.085 * w, 3000);
  },

  /** Flip: a pitch-swept tick. The sweep is the card turning over. */
  card_flip(g, t0, o) {
    const h = head(g, o, 0.08);
    const bg = gain(g, 0);
    const bp = filt(g, 'bandpass', 2400, 4);
    const n = noise(g, 'white', t0, 0.05);
    n.connect(bp); bp.connect(bg); bg.connect(h);
    glide(bp.frequency, t0, f(o, 2300), f(o, 5200), 0.04);
    perc(bg.gain, t0, 0.16, 0.001, 0.038);
    autoFree(n, bp);
    /* A tiny pitched edge so the sweep has a direction the ear can name.
     *
     * ── IT WAS NOT TINY (§P10 round 2) ──────────────────────────────────
     * MEASURED per octave band over the cue's own 30ms window: 1k −51.5 dB
     * against 2k −56.2 and 4k −59.9. The 900→1600Hz square was the LOUDEST
     * part of a cue §7 describes as a "pitch-swept tick" — 0.035 against the
     * noise's 0.1 looks smaller, but one is a tone and the other is broadband
     * noise through a Q=4 bandpass, so in-band the tone won by 5dB.
     *
     * That mattered beyond this cue: in the round-2 masking analysis card_flip
     * was the cue BINDING the entire music mix, and it was binding it at 1kHz,
     * a band the flip is not supposed to live in. Square −8dB / noise +4dB
     * moves the cue's own peak band to 2k where the sweep actually is, at the
     * same total level. The flip sounds more like a card and less like a beep,
     * and the beds got 4dB back for free. */
    const og = gain(g, 0);
    const ov = osc(g, 'square', f(o, 900), t0, t0 + 0.035);
    const olp = filt(g, 'lowpass', 3000, 1);
    glide(ov.frequency, t0, f(o, 900), f(o, 1600), 0.03);
    ov.connect(olp); olp.connect(og); og.connect(h);
    perc(og.gain, t0, 0.014, 0.001, 0.028);
  },

  /** Hands are out: two soft taps, the dealer squaring up. */
  deal_done(g, t0, o) {
    const h = head(g, o, 0.12);
    thump(g, h, t0, f(o, 190), f(o, 95), 0.1, 0.09);
    thump(g, h, t0 + 0.085, f(o, 175), f(o, 88), 0.075, 0.1);
    tick(g, h, t0 + 0.085, 0.05, 2200);
  },

  /** Game start: a knuckle on the table. Two knocks, dry. */
  deal_start(g, t0, o) {
    const h = head(g, o, 0.18);
    for (let i = 0; i < 2; i++) {
      const t = t0 + i * 0.13;
      thump(g, h, t, f(o, 120), f(o, 62), 0.2 - i * 0.04, 0.11);
      burst(g, h, t, 0.03, 480, 1.4, 0.07, 1, 'pink');
    }
  },

  /**
   * Card lifted under a finger. Half a slide, no landing.
   *
   * ── IT HAS TO CLEAR THE MUSIC (§P9 FEEL round 3) ──────────────────────────
   * MEASURED through the real chain: peak -36.5 dBFS, RMS -65.1 — 18.4dB under
   * card_snap and sitting AT the match bed's own RMS. The most-repeated
   * interaction in the game (~200 presses a session, and §P7.2 made it the
   * ≤1-frame acknowledgement of every press) was being masked by its own
   * soundtrack. A press that cannot be heard is a press that has not been
   * answered.
   *
   * Two changes, and the first one matters more than the level:
   *   • a 2ms stock TICK. Pure filtered breath has no onset, so it had nothing
   *     to punch through a bed with; the click is what makes card stock read as
   *     card stock (it is the same primitive every landing and flip uses).
   *   • MIX_DB.card_pickup lifts the whole thing — see the trim table. It stays
   *     tier 4: still well under card_snap, which is the ANSWER to this
   *     question and must remain the louder of the two.
   */
  card_pickup(g, t0, o) {
    const h = head(g, o, 0.06);
    const bg = gain(g, 0);
    const bp = filt(g, 'bandpass', 1200, 1.1);
    const n = noise(g, 'pink', t0, 0.09, 1.2);
    n.connect(bp); bp.connect(bg); bg.connect(h);
    glide(bp.frequency, t0, f(o, 1100), f(o, 2300), 0.06);
    swell(bg.gain, t0, 0.11, 0.006, 0.010, 0.062);
    // The onset. Quiet in absolute terms and the whole reason the sound has an
    // edge to hear: 3.4kHz, 9ms, gone before the breath is at peak.
    tick(g, h, t0, 0.055, 3400, 0.009);
    autoFree(n, bp);
  },

  /** Sheet/detail open. The quietest thing in the bank; it fires on every tap. */
  ui_tick(g, t0, o) {
    const h = head(g, o, 0.04, g.uiBus);
    tick(g, h, t0, 0.09, 2600, 0.016);
    const og = gain(g, 0);
    const ov = osc(g, 'triangle', f(o, 1760), t0, t0 + 0.04);
    ov.connect(og); og.connect(h);
    perc(og.gain, t0, 0.05, 0.001, 0.034);
  },

  /**
   * Denied (§7's "dull thud + short downglide"). Everything about it is closed:
   * lowpassed thud, a triangle falling a fourth, no tail. It must never be
   * mistakeable for the sour cue — that one is about loss, this one is about the
   * move not being legal.
   */
  denied(g, t0, o) {
    const h = head(g, o, 0.05);
    const lp = filt(g, 'lowpass', 520, 0.9);
    lp.connect(h);
    thump(g, lp, t0, f(o, 118), f(o, 72), 0.24, 0.13);
    const og = gain(g, 0);
    const ov = osc(g, 'triangle', f(o, 330), t0, t0 + 0.18);
    const olp = filt(g, 'lowpass', 900, 1.1);
    glide(ov.frequency, t0, f(o, 330), f(o, 196), 0.15);
    ov.connect(olp); olp.connect(og); og.connect(h);
    perc(og.gain, t0, 0.11, 0.004, 0.16);
    burst(g, h, t0, 0.05, 380, 0.9, 0.06, 1, 'pink');
  },

  /* ── money ──────────────────────────────────────────────────────────── */

  /**
   * A chip on the felt. Two inharmonic partials (ratio 1.345 — deliberately not
   * an octave or a fifth, or it reads as a bell) with a metal tick on top.
   */
  chip(g, t0, o) {
    const h = head(g, o, 0.26);
    const base = f(o, 2340);
    const a = gain(g, 0);
    const oa = osc(g, 'sine', base, t0, t0 + 0.13);
    oa.connect(a); a.connect(h);
    perc(a.gain, t0, 0.1, 0.001, 0.1);
    const b = gain(g, 0);
    const ob = osc(g, 'sine', base * 1.345, t0, t0 + 0.09);
    ob.connect(b); b.connect(h);
    perc(b.gain, t0, 0.055, 0.001, 0.07);
    tick(g, h, t0, 0.055, 4200, 0.01);
    thump(g, h, t0, f(o, 210), f(o, 130), 0.05, 0.05);
  },

  /** A stack of chips pushed across: three clinks, falling, then a settle. */
  chip_pay(g, t0, o) {
    const h = head(g, o, 0.26);
    let base = f(o, 2500);
    for (let i = 0; i < 3; i++) {
      const t = t0 + i * (0.052 - i * 0.006);
      const a = gain(g, 0);
      const oa = osc(g, 'sine', base, t, t + 0.12);
      oa.connect(a); a.connect(h);
      perc(a.gain, t, 0.085 - i * 0.012, 0.001, 0.09);
      const b = gain(g, 0);
      const ob = osc(g, 'sine', base * 1.345, t, t + 0.07);
      ob.connect(b); b.connect(h);
      perc(b.gain, t, 0.04, 0.001, 0.055);
      tick(g, h, t, 0.04, 4200, 0.01);
      base *= 0.94;
    }
    thump(g, h, t0 + 0.11, f(o, 190), f(o, 105), 0.09, 0.12);
  },

  /* ── reward: the set-progress ladder (§7) ───────────────────────────── */

  set_progress_0(g, t0, o) { return rung(g, t0, o, 0); },
  set_progress_1(g, t0, o) { return rung(g, t0, o, 1); },
  set_progress_2(g, t0, o) { return rung(g, t0, o, 2); },
  set_progress_3(g, t0, o) { return rung(g, t0, o, 3); },

  /** FOC / hangar placed: a short two-note lift, plainer than the ladder. */
  upgrade(g, t0, o) {
    const h = head(g, o, 0.24);
    const notes = [392, 587.33];
    notes.forEach((hz, i) => {
      const t = t0 + i * 0.075;
      const vg = gain(g, 0);
      const ov = osc(g, 'triangle', f(o, hz), t, t + 0.3);
      ov.connect(vg); vg.connect(h);
      perc(vg.gain, t, 0.16 - i * 0.02, 0.004, 0.24);
    });
    tick(g, h, t0, 0.06, 3400, 0.012);
  },

  /* ── the sour half (§7) ─────────────────────────────────────────────── */

  /**
   * THE SOUR CUE — ROBBED. A property or a whole set taken off YOUR board.
   *
   * One of three losses, and the worst of them: `sour_pay` is a transaction and
   * `sour_broke` is an emptiness, but this is somebody's hand on your card.
   * (Round-1 critique measured all three sharing one voice, so a 3-card set
   * theft and a 1M rent payment were acoustically the same event.)
   *
   * Sour, not merely low: a tritone against the root, both voices gliding DOWN,
   * a sawtooth instead of a triangle, and a lowpass closing over the whole thing
   * so it goes dull as it falls. The fundamental is Eb4 (311Hz) falling to ~224 —
   * tools/audiotest.mjs asserts the measured fundamental sits BELOW the ladder's
   * first rung (523Hz), because reward and punishment reading alike is the one
   * failure a player cannot learn around.
   *
   * The lowpass starts at 800Hz, under the sawtooth's second harmonic (622Hz at
   * onset), so the DFT in the tool sees the fundamental and not a partial.
   *
   * `big` is the severity axis and it is REACHABLE (engine.js bigFor): a set
   * stolen whole, a CHUD hit, or a card pulled out of a completed set. It adds
   * the sub-octave and a longer, deeper fall — measured as a separate row in the
   * offline mix table, not as a comment.
   */
  sour(g, t0, o) {
    const big = !!o.big;
    const h = head(g, o, big ? 0.28 : 0.2);
    const root = f(o, 311.13);
    const fall = big ? 0.6 : 0.72;              // big drops a fifth, not a third
    const span = big ? 0.6 : 0.44;
    const env = gain(g, 0);
    env.connect(h);
    const lp = filt(g, 'lowpass', 800, 1.1);
    lp.connect(env);
    lp.frequency.setValueAtTime(800, t0);
    lp.frequency.exponentialRampToValueAtTime(big ? 280 : 360, t0 + span + 0.01);

    const g1 = gain(g, 0.5);
    const o1 = osc(g, 'sawtooth', root, t0, t0 + span + 0.12);
    glide(o1.frequency, t0, root, root * fall, span);
    o1.connect(g1); g1.connect(lp);

    // The tritone is what makes it sour.
    const g2 = gain(g, 0.2);
    const o2 = osc(g, 'square', root * semis(6), t0, t0 + span + 0.12);
    glide(o2.frequency, t0, root * semis(6), root * semis(6) * fall, span);
    o2.connect(g2); g2.connect(lp);

    if (big) {
      // Sub-octave: the floor going out from under it. Quiet enough (-13dB
      // against the fundamental) that the tool's DFT still ranks 311Hz first.
      const g3 = gain(g, 0.22);
      const o3 = osc(g, 'sawtooth', root * 0.5, t0, t0 + span + 0.12);
      glide(o3.frequency, t0, root * 0.5, root * 0.5 * fall, span);
      o3.connect(g3); g3.connect(lp);
      // The card being pulled: a short reversed-sounding scrape at the onset.
      burst(g, h, t0, 0.09, 1100, 1.6, 0.1, 1.25, 'pink');
    }
    perc(env.gain, t0, big ? 0.44 : 0.33, 0.006, span + 0.06);
  },

  /**
   * SOUR — PAID. You handed value over because you were charged. A transaction,
   * not a theft: it keeps the chips (you gave something of value), the tritone
   * only sags a minor third, and it is over in ~330ms so the payment caravan's
   * own landings still read.
   *
   * Deliberately the LEAST severe of the three losses (see the mix table): you
   * chose which cards went, and you may get them back.
   */
  sour_pay(g, t0, o) {
    const h = head(g, o, 0.22);
    const root = f(o, 311.13);
    const env = gain(g, 0);
    env.connect(h);
    const lp = filt(g, 'lowpass', 1200, 1.0);
    lp.connect(env);
    glide(lp.frequency, t0, 1200, 520, 0.3);

    const g1 = gain(g, 0.5);
    const o1 = osc(g, 'sawtooth', root, t0, t0 + 0.36);
    glide(o1.frequency, t0, root, root * 0.84, 0.28);   // a minor third, no more
    o1.connect(g1); g1.connect(lp);
    const g2 = gain(g, 0.16);
    const o2 = osc(g, 'square', root * semis(6), t0, t0 + 0.36);
    glide(o2.frequency, t0, root * semis(6), root * semis(6) * 0.84, 0.28);
    o2.connect(g2); g2.connect(lp);
    perc(env.gain, t0, 0.3, 0.004, 0.3);

    // Two chip clinks leaving: the money side of the same beat. This is the
    // audible difference from `sour` at a glance — value moved, nothing was taken.
    for (let i = 0; i < 2; i++) {
      const t = t0 + 0.02 + i * 0.062;
      const cg = gain(g, 0);
      const cv = osc(g, 'sine', f(o, 2380) * (1 - i * 0.06), t, t + 0.09);
      cv.connect(cg); cg.connect(h);
      perc(cg.gain, t, 0.05 - i * 0.012, 0.001, 0.07);
      tick(g, h, t, 0.03, 4200, 0.01);
    }
  },

  /**
   * SOUR — INSOLVENT. You were charged and had nothing. §3.4's "pay with
   * everything you have" already emptied you; this is the sound of the board
   * being scraped clean.
   *
   * Hollow by construction: no attack transient at all (a 90ms linear swell),
   * the widest fall of the three (a full fifth over 640ms), the lowpass closing
   * to 220Hz, and an air-only noise bed under it. Longest of the three losses
   * and the only one with no percussive edge — there was nothing to land.
   */
  sour_broke(g, t0, o) {
    const h = head(g, o, 0.34);
    const root = f(o, 311.13);
    const env = gain(g, 0);
    env.connect(h);
    const lp = filt(g, 'lowpass', 700, 1.2);
    lp.connect(env);
    glide(lp.frequency, t0, 700, 220, 0.66);

    for (const [mult, amp, type] of [[1, 0.46, 'sawtooth'], [semis(6), 0.2, 'square'], [0.5, 0.26, 'sawtooth']]) {
      const vg = gain(g, amp);
      const ov = osc(g, type, root * mult, t0, t0 + 0.78);
      glide(ov.frequency, t0, root * mult, root * mult * 0.667, 0.64);
      ov.connect(vg); vg.connect(lp);
    }
    // No perc(): a swell, so there is no strike. That is the whole character.
    swell(env.gain, t0, 0.34, 0.09, 0.1, 0.5);

    const ag = gain(g, 0);
    const ahp = filt(g, 'highpass', 900, 0.6);
    const an = noise(g, 'pink', t0, 0.68);
    an.connect(ahp); ahp.connect(ag); ag.connect(h);
    swell(ag.gain, t0, 0.05, 0.12, 0.1, 0.42);
    autoFree(an, ahp);
  },

  /**
   * A property leaving somebody's board and landing on the thief's. Heard by
   * everyone who is not the victim (the victim gets `sour`): a fast upward rip
   * with a pluck under it — acquisitive, not sad.
   */
  steal(g, t0, o) {
    const h = head(g, o, 0.22);
    const bg = gain(g, 0);
    const bp = filt(g, 'bandpass', 900, 2.2);
    const n = noise(g, 'white', t0, 0.18);
    n.connect(bp); bp.connect(bg); bg.connect(h);
    glide(bp.frequency, t0, f(o, 420), f(o, 2600), 0.15);
    swell(bg.gain, t0, 0.14, 0.01, 0.02, 0.13);
    autoFree(n, bp);
    const pg = gain(g, 0);
    const pv = osc(g, 'triangle', f(o, 220), t0 + 0.02, t0 + 0.3);
    glide(pv.frequency, t0 + 0.02, f(o, 220), f(o, 330), 0.14);
    const plp = filt(g, 'lowpass', 1800, 1.2);
    pv.connect(plp); plp.connect(pg); pg.connect(h);
    perc(pg.gain, t0 + 0.02, 0.16, 0.005, 0.25);
  },

  /** A charge landing on somebody: two insistent, falling square blips. */
  demand(g, t0, o) {
    const h = head(g, o, 0.18);
    const lp = filt(g, 'lowpass', 2200, 0.9);
    lp.connect(h);
    [466.16, 415.3].forEach((hz, i) => {
      const t = t0 + i * 0.13;
      const vg = gain(g, 0);
      const ov = osc(g, 'square', f(o, hz), t, t + 0.14);
      ov.connect(vg); vg.connect(lp);
      perc(vg.gain, t, 0.13, 0.004, 0.11);
    });
    thump(g, h, t0, f(o, 130), f(o, 80), 0.11, 0.14);
  },

  /* ── the action families (§4 play_action) ───────────────────────────────
   *
   * Round-1 critique: six of the seven action families resolved to `null`, so
   * 20 play_action events in a full game produced one sting and an Inspector
   * General sounded exactly like a discard. These are the CARD HITTING THE
   * TABLE WITH INTENT — short (≤260ms, the choreographer's play_action step),
   * quieter than the consequence event that follows them (steal / demand /
   * rent_charged / draw), and each one is a different gesture, not a different
   * pitch of the same gesture:
   *
   *   act_steal  a hook   — bandpass scrape DOWN then UP, a low knock
   *   act_swap   a cross  — two triangles trading places, one up one down
   *   act_demand a slap   — dry paper hit, one flat square stab, no movement
   *   act_rent   a meter  — bright square figure running UP, chip edge
   *   act_draw   a flick  — two riffle grains and an upward tick
   *   act_surge  a double — rising whoosh under a 24Hz amplitude flutter
   *
   * chud, upgrade/foc and opsec are NOT here: they already own a voice, and the
   * `upgrade` / `opsec` events fire on the same beat (engine.js maps them null
   * on the play_action leg so nothing doubles).
   */

  /** Requisition / Inspector General leaving the hand: a hook going out. */
  act_steal(g, t0, o) {
    const h = head(g, o, 0.16);
    const bg = gain(g, 0);
    const bp = filt(g, 'bandpass', 1200, 3.2);
    const n = noise(g, 'white', t0, 0.16, 1.1);
    n.connect(bp); bp.connect(bg); bg.connect(h);
    // Down then up — a hand reaching across and closing. `steal` (the landing)
    // is a single rise, so the pair reads as reach → take.
    glide3(bp.frequency, t0, f(o, 1500), f(o, 620), f(o, 1900), 0.06, 0.08);
    swell(bg.gain, t0, o.big ? 0.15 : 0.115, 0.008, 0.02, 0.11);
    autoFree(n, bp);
    thump(g, h, t0, f(o, 142), f(o, 74), o.big ? 0.16 : 0.12, 0.1);
    tick(g, h, t0, 0.05, 3200, 0.012);
  },

  /** TDY Orders: two voices crossing. Trade, not theft (§3.1). */
  act_swap(g, t0, o) {
    const h = head(g, o, 0.2);
    const lp = filt(g, 'lowpass', 2600, 0.9);
    lp.connect(h);
    for (const [from, to] of [[329.63, 493.88], [493.88, 329.63]]) {
      const vg = gain(g, 0);
      const ov = osc(g, 'triangle', f(o, from), t0, t0 + 0.24);
      glide(ov.frequency, t0, f(o, from), f(o, to), 0.16);
      ov.connect(vg); vg.connect(lp);
      swell(vg.gain, t0, 0.13, 0.02, 0.06, 0.14);
    }
    // The two cards passing each other on the felt.
    burst(g, h, t0, 0.09, 1500, 1.1, 0.07, 1.1, 'pink');
    burst(g, h, t0 + 0.07, 0.09, 1100, 1.1, 0.06, 0.9, 'pink');
  },

  /** Finance Office / Roll Call: paperwork served. Flat and bureaucratic. */
  act_demand(g, t0, o) {
    const h = head(g, o, 0.12);
    // The slap: a dry hit with no tail, brighter and harder than card_snap.
    thump(g, h, t0, f(o, 175), f(o, 82), 0.19, 0.075);
    burst(g, h, t0, 0.04, 620, 1.0, 0.1, 1, 'pink');
    tick(g, h, t0, 0.1, 3600, 0.014);
    // One stab, no glide — a demand does not negotiate. `demand` (the charge
    // landing) is the two falling blips; this is the stamp before it.
    const vg = gain(g, 0);
    const lp = filt(g, 'lowpass', 1500, 0.9);
    const ov = osc(g, 'square', f(o, 246.94), t0 + 0.02, t0 + 0.2);
    ov.connect(lp); lp.connect(vg); vg.connect(h);
    perc(vg.gain, t0 + 0.02, 0.13, 0.004, 0.15);
  },

  /** A rent card played: a meter running up. Rising, because you are collecting. */
  act_rent(g, t0, o) {
    const h = head(g, o, 0.2);
    const bp = filt(g, 'bandpass', 1400, 1.4);
    bp.connect(h);
    [523.25, 659.25, 783.99].forEach((hz, i) => {
      const t = t0 + i * 0.045;
      const vg = gain(g, 0);
      const ov = osc(g, 'square', f(o, hz), t, t + 0.1);
      ov.connect(vg); vg.connect(bp);
      perc(vg.gain, t, 0.09, 0.002, 0.075);
    });
    tick(g, h, t0, 0.055, 4000, 0.012);
    thump(g, h, t0, f(o, 150), f(o, 92), 0.075, 0.09);
  },

  /** PCS Orders: two cards flicked off the deck toward you. */
  act_draw(g, t0, o) {
    const h = head(g, o, 0.14);
    for (let i = 0; i < 2; i++) {
      const t = t0 + i * 0.062;
      burst(g, h, t, 0.03, 1900 + i * 500, 3.5, 0.09, 1 + i * 0.15);
      tick(g, h, t + 0.012, 0.05, 3000, 0.012);
    }
    // The upward flick: a short pitched edge so it reads as gain, not handling.
    const og = gain(g, 0);
    const ov = osc(g, 'triangle', f(o, 440), t0 + 0.05, t0 + 0.22);
    glide(ov.frequency, t0 + 0.05, f(o, 440), f(o, 659.25), 0.1);
    ov.connect(og); og.connect(h);
    perc(og.gain, t0 + 0.05, 0.085, 0.005, 0.13);
  },

  /** Surge Ops: the next RENT is about to multiply (§3.1c — it stacks, and it
   *  never touches Finance Office or Roll Call). A rise with a flutter on it. */
  act_surge(g, t0, o) {
    const h = head(g, o, 0.24);
    const env = gain(g, 0);
    env.connect(h);
    const bp = filt(g, 'bandpass', 700, 1.4);
    bp.connect(env);
    glide(bp.frequency, t0, f(o, 500), f(o, 2600), 0.22);
    const n = noise(g, 'white', t0, 0.26, 1.1);
    n.connect(bp);
    // 24Hz flutter: literally an amplitude doubling, which is what the card does.
    const lfo = osc(g, 'square', 24, t0, t0 + 0.26);
    const lfoAmt = gain(g, 0.06);
    lfo.connect(lfoAmt); lfoAmt.connect(env.gain);
    swell(env.gain, t0, 0.13, 0.03, 0.09, 0.14);
    autoFree(n, bp);
    const og = gain(g, 0);
    const ov = osc(g, 'sawtooth', f(o, 196), t0, t0 + 0.28);
    glide(ov.frequency, t0, f(o, 196), f(o, 392), 0.2);
    const olp = filt(g, 'lowpass', 1400, 1.2);
    ov.connect(olp); olp.connect(og); og.connect(h);
    perc(og.gain, t0, 0.11, 0.02, 0.22);
  },

  /**
   * A PROPERTY SEATING INTO A COLUMN. Round-1 critique: play_property mapped to
   * null, so placing a property and throwing one away were the same sound (both
   * got only the cue channel's card_snap).
   *
   * This layers UNDER that snap rather than replacing it — the snap is the card
   * hitting felt, this is the short warm confirmation that it is yours and it
   * stays. A discard gets the snap alone, so the two are now told apart by the
   * presence of a pitch at all.
   */
  prop_place(g, t0, o) {
    const h = head(g, o, 0.18);
    const lp = filt(g, 'lowpass', 2000, 0.9);
    lp.connect(h);
    // A fifth, up: the smallest possible "that belongs there".
    const vg = gain(g, 0);
    const ov = osc(g, 'triangle', f(o, 293.66), t0 + 0.01, t0 + 0.2);
    glide(ov.frequency, t0 + 0.01, f(o, 293.66), f(o, 440), 0.06);
    ov.connect(vg); vg.connect(lp);
    perc(vg.gain, t0 + 0.01, 0.12, 0.006, 0.15);
    // Felt press, not a knock: no tick, so it cannot be mistaken for a landing.
    burst(g, h, t0, 0.045, 320, 1.1, 0.055, 1, 'pink');
  },

  /**
   * OPSEC: a metallic parry. Five inharmonic partials around 640Hz through a
   * bandpass, bent down over 90ms — two blades meeting, not a bell. The bright
   * transient is what makes it read as "stopped" rather than "played".
   */
  opsec(g, t0, o) {
    const h = head(g, o, 0.34);
    const bp = filt(g, 'bandpass', 2400, 1.6);
    const env = gain(g, 0);
    bp.connect(env); env.connect(h);
    const ratios = [1, 1.41, 1.93, 2.61, 3.34];
    const base = f(o, 640);
    for (let i = 0; i < ratios.length; i++) {
      const vg = gain(g, 0.4 / (i + 1));
      const ov = osc(g, i === 0 ? 'triangle' : 'square', base * ratios[i], t0, t0 + 0.34);
      glide(ov.frequency, t0, base * ratios[i], base * ratios[i] * 0.9, 0.09);
      ov.connect(vg); vg.connect(bp);
    }
    perc(env.gain, t0, 0.3, 0.002, 0.3);
    tick(g, h, t0, 0.13, 4600, 0.014);
  },

  /**
   * The counter landed: the same parry, cut dead. Short tail, a thud under it,
   * no ring — an action that stopped moving.
   */
  blocked(g, t0, o) {
    const h = head(g, o, 0.12);
    const bp = filt(g, 'bandpass', 1500, 2.2);
    const env = gain(g, 0);
    bp.connect(env); env.connect(h);
    [1, 1.41, 2.37].forEach((r, i) => {
      const vg = gain(g, 0.4 / (i + 1));
      const ov = osc(g, 'square', f(o, 520) * r, t0, t0 + 0.13);
      ov.connect(vg); vg.connect(bp);
    });
    perc(env.gain, t0, 0.26, 0.002, 0.1);
    thump(g, h, t0 + 0.01, f(o, 132), f(o, 70), 0.2, 0.16);
    tick(g, h, t0, 0.1, 3800, 0.012);
  },

  /**
   * CHUD. §7 gives exactly one moment a klaxon and this is it: a sawtooth pair
   * an octave apart, gated three times, falling 190 -> 120Hz under a lowpass
   * that closes from 3kHz to 600Hz. Loud, dirty, and over in 620ms.
   */
  chud(g, t0, o) {
    const h = head(g, o, 0.3);
    const lp = filt(g, 'lowpass', 3000, 1.4);
    const env = gain(g, 0);
    lp.connect(env); env.connect(h);
    glide(lp.frequency, t0, 3000, 600, 0.55);

    const hi = osc(g, 'sawtooth', f(o, 190), t0, t0 + 0.64);
    const hg = gain(g, 0.34);
    glide3(hi.frequency, t0, f(o, 190), f(o, 215), f(o, 120), 0.18, 0.4);
    hi.connect(hg); hg.connect(lp);

    const lo = osc(g, 'square', f(o, 95), t0, t0 + 0.64);
    const lg = gain(g, 0.2);
    glide3(lo.frequency, t0, f(o, 95), f(o, 107), f(o, 60), 0.18, 0.4);
    lo.connect(lg); lg.connect(lp);

    // Three gate pulses: the "wah" that makes a tone a klaxon.
    const a = env.gain;
    a.setValueAtTime(EPS, t0);
    for (let i = 0; i < 3; i++) {
      const t = t0 + i * 0.19;
      a.exponentialRampToValueAtTime(0.42 - i * 0.07, t + 0.02);
      a.exponentialRampToValueAtTime(0.12, t + 0.15);
    }
    a.exponentialRampToValueAtTime(EPS, t0 + 0.62);
    a.setValueAtTime(0, t0 + 0.63);

    burst(g, h, t0, 0.12, 900, 0.8, 0.13);
  },

  /** A board swept out: a long falling swish with a low tone dropping under it. */
  scoop(g, t0, o) {
    const h = head(g, o, 0.3);
    const bg = gain(g, 0);
    const bp = filt(g, 'bandpass', 2600, 1.1);
    const n = noise(g, 'pink', t0, 0.5);
    n.connect(bp); bp.connect(bg); bg.connect(h);
    glide(bp.frequency, t0, f(o, 2800), f(o, 300), 0.44);
    swell(bg.gain, t0, 0.16, 0.02, 0.06, 0.4);
    autoFree(n, bp);
    const og = gain(g, 0);
    const ov = osc(g, 'triangle', f(o, 260), t0, t0 + 0.5);
    glide(ov.frequency, t0, f(o, 260), f(o, 98), 0.42);
    ov.connect(og); og.connect(h);
    perc(og.gain, t0, 0.16, 0.01, 0.44);
  },

  /* ── the turn ───────────────────────────────────────────────────────── */

  /** Your turn: a warm tick and a short rise. The only turn cue with pitch UP. */
  turn_mine(g, t0, o) {
    const h = head(g, o, 0.2);
    tick(g, h, t0, 0.09, 2400, 0.014);
    const og = gain(g, 0);
    const ov = osc(g, 'triangle', f(o, 587.33), t0, t0 + 0.22);
    glide(ov.frequency, t0, f(o, 587.33), f(o, 880), 0.09);
    ov.connect(og); og.connect(h);
    perc(og.gain, t0, 0.19, 0.004, 0.19);
    thump(g, h, t0, f(o, 150), f(o, 96), 0.08, 0.08);
  },

  /**
   * Turn timer at 10s (§5). ui/hud.js fires this ONCE per timer, not per tick.
   * Two soft blips a fifth apart — a reminder, deliberately not an alarm; the
   * klaxon family is reserved for §3.10 and CHUD.
   */
  timer_warn(g, t0, o) {
    // sfxBus, not uiBus: "your turn ends in 10 seconds" is game state, not
    // chrome, and uiBus sits 5dB lower so it can carry taps without shouting.
    const h = head(g, o, 0.14);
    [880, 880].forEach((hz, i) => {
      const t = t0 + i * 0.1;
      const vg = gain(g, 0);
      const ov = osc(g, 'sine', f(o, hz), t, t + 0.13);
      ov.connect(vg); vg.connect(h);
      perc(vg.gain, t, 0.16, 0.004, 0.11);
    });
  },

  /** Turn timer at 5s (§5). Three faster, brighter pulses, rising, with a pulse
   *  of low body under them so it is felt as well as heard. */
  timer_critical(g, t0, o) {
    const h = head(g, o, 0.14);
    for (let i = 0; i < 3; i++) {
      const t = t0 + i * 0.075;
      const vg = gain(g, 0);
      const lp = filt(g, 'lowpass', 3600, 0.9);
      const ov = osc(g, 'square', f(o, 1046.5) * (1 + i * 0.06), t, t + 0.09);
      ov.connect(lp); lp.connect(vg); vg.connect(h);
      perc(vg.gain, t, 0.16, 0.002, 0.07);
    }
    thump(g, h, t0, f(o, 150), f(o, 90), 0.12, 0.13);
  },

  /** Somebody else's turn: one dry, flat tick. Deliberately uninteresting. */
  turn_other(g, t0, o) {
    const h = head(g, o, 0.1);
    tick(g, h, t0, 0.055, 2000, 0.012);
    const og = gain(g, 0);
    const ov = osc(g, 'sine', f(o, 392), t0, t0 + 0.07);
    ov.connect(og); og.connect(h);
    perc(og.gain, t0, 0.06, 0.003, 0.06);
  },

  /* ── final approach (§3.10) ─────────────────────────────────────────── */

  /**
   * Armed. A two-pulse alarm rising a fourth, with a sub swell under it and a
   * vibrato on the top voice. Related to `chud` (same family of dirty sawtooth)
   * but rising where CHUD falls, because one is a threat arriving and the other
   * is a countdown starting.
   */
  klaxon(g, t0, o) {
    const h = head(g, o, 0.35);
    const lp = filt(g, 'lowpass', 2600, 1.3);
    lp.connect(h);

    // Vibrato: 5.5Hz, ±9Hz. Slow enough to read as an alarm, not a warble.
    const lfo = osc(g, 'sine', 5.5, t0, t0 + 1.1);
    const lfoAmt = gain(g, 9);
    lfo.connect(lfoAmt);

    for (let i = 0; i < 2; i++) {
      const t = t0 + i * 0.42;
      const vg = gain(g, 0);
      const ov = osc(g, 'sawtooth', f(o, 220), t, t + 0.4);
      glide(ov.frequency, t, f(o, 220), f(o, 293.66), 0.3);
      lfoAmt.connect(ov.frequency);
      ov.connect(vg); vg.connect(lp);
      swell(vg.gain, t, 0.3, 0.05, 0.12, 0.2);
    }
    const sg = gain(g, 0);
    const sv = osc(g, 'sine', f(o, 55), t0, t0 + 1.0);
    sv.connect(sg); sg.connect(h);
    swell(sg.gain, t0, 0.2, 0.14, 0.4, 0.42);

    burst(g, h, t0, 0.09, 1400, 0.9, 0.1);
  },

  /**
   * One tick of the tension bed. Quiet by construction — engine.js also routes
   * it through bedBus at -22dB, so §7's "≤ -20dB bed" holds twice over.
   */
  tension_tick(g, t0, o) {
    const h = head(g, o, 0.14, g.bedBus);
    burst(g, h, t0, 0.014, 1600, 6, 0.16);
    thump(g, h, t0, 62, 46, 0.1, 0.05);
  },

  /** Disarmed: the alarm winding down. A fall, a filter closing, then nothing. */
  approach_broken(g, t0, o) {
    const h = head(g, o, 0.22);
    const lp = filt(g, 'lowpass', 2200, 1);
    const env = gain(g, 0);
    lp.connect(env); env.connect(h);
    glide(lp.frequency, t0, 2200, 400, 0.34);
    const ov = osc(g, 'sawtooth', f(o, 440), t0, t0 + 0.4);
    glide(ov.frequency, t0, f(o, 440), f(o, 196), 0.32);
    const vg = gain(g, 0.36);
    ov.connect(vg); vg.connect(lp);
    perc(env.gain, t0, 0.3, 0.008, 0.36);
    burst(g, h, t0, 0.16, 700, 0.8, 0.06, 1, 'pink');
  },

  /* ── the endgame ────────────────────────────────────────────────────── */

  /**
   * Win. §7: "restrained military ceremony". Four bugle-ish notes on the
   * harmonic series (G3 C4 E4 G4) — sawtooth stacks through a lowpass that
   * opens on each attack, which is the whole trick to brass without samples —
   * a timpani under the first and last, and the confetti crackle over the top.
   *
   * Restrained means: no held major chord, no cymbal, no octave-up sparkle.
   *
   * ── TIMING AGAINST THE WIN BEAT (round-1 critique) ────────────────────────
   * The choreographer holds the queue 320ms on `win` (choreographer.js:189) and
   * ui/ gates the victory overlay on CHOREO_IDLE, so the window in which the
   * player is looking at the TABLE is ~320ms. The four-note statement used to
   * finish at 390+300 = 690ms — its resolving note landed after the overlay had
   * already opened over it.
   *
   * Retimed to 0 / 90 / 180 / 270ms: the phrase RESOLVES at 270ms, inside the
   * beat, on a visible table. Everything after that is deliberate tail — the
   * held fifth and the confetti crackle — which is the part that should carry
   * INTO the overlay rather than be cut by it. Total 1.19s, of which 0.92s is
   * tail that nothing has to wait for.
   */
  fanfare(g, t0, o) {
    const h = head(g, o, 0.4);
    const notes = [
      [196.00, 0.00, 0.22],
      [261.63, 0.09, 0.22],
      [329.63, 0.18, 0.22],
      [392.00, 0.27, 0.92],
    ];
    for (const [hz, at, dur] of notes) {
      const t = t0 + at;
      const lp = filt(g, 'lowpass', 500, 1.1);
      const env = gain(g, 0);
      lp.connect(env); env.connect(h);
      // Brass = the cutoff tracking the envelope. 60ms open, then closing.
      lp.frequency.setValueAtTime(500, t);
      lp.frequency.exponentialRampToValueAtTime(3000, t + 0.06);
      lp.frequency.exponentialRampToValueAtTime(900, t + dur);
      for (const [mult, amp, det] of [[1, 0.34, 1], [1, 0.24, 1.004], [2, 0.1, 1]]) {
        const vg = gain(g, amp);
        const ov = osc(g, 'sawtooth', f(o, hz) * mult * det, t, t + dur + 0.05);
        ov.connect(vg); vg.connect(lp);
      }
      swell(env.gain, t, 0.34, 0.02, dur * 0.45, dur * 0.55);
    }
    // A fifth over the last note: the only harmony in the piece. This is tail —
    // it is meant to still be ringing when ui/ opens the overlay.
    const fg = gain(g, 0);
    const fv = osc(g, 'triangle', f(o, 587.33), t0 + 0.27, t0 + 1.18);
    fv.connect(fg); fg.connect(h);
    swell(fg.gain, t0 + 0.27, 0.12, 0.06, 0.36, 0.46);

    thump(g, h, t0, f(o, 110), f(o, 55), 0.26, 0.24);
    thump(g, h, t0 + 0.27, f(o, 110), f(o, 55), 0.24, 0.3);

    // Confetti crackle: 44 grains over 0.9s, density and level both decaying.
    // Paper, not applause — §7 asks for "crowd-less". Starts at 0.25s so the
    // first grains land under the resolving note rather than after it.
    const cg = gain(g, 0.5);
    cg.connect(h);
    let t = t0 + 0.25;
    for (let i = 0; i < 44 && t < t0 + 1.18; i++) {
      const fade = 1 - (t - t0 - 0.25) / 0.9;
      burst(g, cg, t, 0.012, 3200 + g.rng() * 3600, 7, 0.05 * fade * fade);
      t += 0.008 + g.rng() * 0.038;
    }
  },

  /**
   * DEFEAT — somebody else took it (§P9 FEEL round 3).
   *
   * MEASURED before this existed: the bank had `fanfare` and `stalemate` and
   * nothing else, and `win` carries `{actor: winnerId}`, so losing played the
   * WINNER'S FANFARE at the generic somebody-else's-event treatment: -6dB,
   * ±0.34 of pan, -10 cents. Blindfolded, winning and losing were the same
   * sound at two levels — on a game the harness lost, `fanfare mine=0 theirs=1`.
   *
   * The rest of the sour half already passes this test by having a different
   * TIMBRE, not a different level: a theft against you is `sour` (peak 0.415,
   * centred) where a theft you merely witness is `steal` (0.157, panned and
   * detuned). The ending gets the same treatment, and engine.js routes it
   * through SELF_VOICE so it arrives centred and unfiltered — it happened to
   * you, whoever caused it.
   *
   * The construction is fanfare's, inverted at every joint, which is why the
   * two can never be confused:
   *
   *   fanfare                        defeat
   *   ─────────────────────────────  ────────────────────────────────────────
   *   G3 C4 E4 G4, rising major      G4 Eb4 C4 G3, falling MINOR
   *   sawtooth, bright and buzzing   square through a 620Hz lowpass, muted
   *   filter OPENS on each attack    filter CLOSES through each note
   *   notes 90ms apart, urgent       notes 150ms apart, slowing (150/170/210)
   *   a fifth ringing over the end   the last note SAGS a semitone flat
   *   timpani accents, confetti      one dead thud and a long breath of air
   *
   * The sag is the thing that reads as loss: a held pitch that will not stay
   * up. Two detuned squares beat against each other at ~1.4Hz through it, so
   * the tail wavers instead of ringing.
   */
  defeat(g, t0, o) {
    const h = head(g, o, 0.5);
    // G4 Eb4 C4 G3 — the fanfare's own arrival note, walked back down a minor
    // triad to below where the fanfare started.
    const notes = [
      [392.00, 0.00, 0.30],
      [311.13, 0.15, 0.30],
      [261.63, 0.32, 0.34],
      [196.00, 0.53, 1.05],
    ];
    for (let i = 0; i < notes.length; i++) {
      const [hz, at, dur] = notes[i];
      const t = t0 + at;
      const last = i === notes.length - 1;
      const lp = filt(g, 'lowpass', 620, 1.4);
      const env = gain(g, 0);
      lp.connect(env); env.connect(h);
      // Closing, not opening: every note is duller at its end than at its start.
      lp.frequency.setValueAtTime(1500, t);
      lp.frequency.exponentialRampToValueAtTime(320, t + dur * 0.8);
      for (const [amp, det] of [[0.30, 1], [0.22, 1.0035]]) {
        const vg = gain(g, amp);
        const ov = osc(g, 'square', f(o, hz) * det, t, t + dur + 0.05);
        // THE SAG. The final note cannot hold its pitch — a semitone flat over
        // its own length, which is the whole sentence in one gesture.
        if (last) glide(ov.frequency, t + 0.18, f(o, hz) * det, f(o, hz) * det * 0.944, dur * 0.7);
        ov.connect(vg); vg.connect(lp);
      }
      swell(env.gain, t, 0.30, 0.03, dur * 0.35, dur * 0.62);
    }
    // One dead thud under the first note — a timpani with the head damped.
    thump(g, h, t0, f(o, 98), f(o, 46), 0.30, 0.34);
    // …and a long breath of air where the confetti would have been. Filtered
    // brown noise, no grains, decaying to nothing over 1.3s.
    const ag = gain(g, 0);
    const alp = filt(g, 'lowpass', 700, 0.6);
    const an = noise(g, 'brown', t0 + 0.5, 1.3, 0.8);
    an.connect(alp); alp.connect(ag); ag.connect(h);
    glide(alp.frequency, t0 + 0.5, 700, 220, 1.1);
    swell(ag.gain, t0 + 0.5, 0.22, 0.18, 0.2, 0.9);
    autoFree(an, alp);
  },

  /**
   * Stalemate (§3.6, §3.11). Deliberately unresolved: a major second held low
   * (G3 against A3) under a closed filter, fading with no cadence. It should
   * feel like the deck running out, which is what happened.
   */
  stalemate(g, t0, o) {
    const h = head(g, o, 0.3);
    const lp = filt(g, 'lowpass', 900, 0.9);
    const env = gain(g, 0);
    lp.connect(env); env.connect(h);
    glide(lp.frequency, t0, 900, 420, 0.8);
    for (const hz of [196.0, 220.0]) {
      const vg = gain(g, 0.3);
      const ov = osc(g, 'triangle', f(o, hz), t0, t0 + 1.0);
      ov.connect(vg); vg.connect(lp);
    }
    swell(env.gain, t0, 0.3, 0.05, 0.2, 0.72);
    burst(g, h, t0, 0.2, 500, 0.7, 0.05, 1, 'pink');
  },
});

/**
 * One rung of the ladder. Harmonics are deliberately quiet (-16dB and -26dB)
 * and there is NOTHING below the fundamental, so the spectral peak the tool
 * measures IS the fundamental. A bell-like inharmonic partial sounded better in
 * isolation and made the invariant untestable, which is a bad trade.
 */
function rung(g, t0, o, i) {
  const idx = clamp(i | 0, 0, LADDER_DEGREES.length - 1);
  const f0 = f(o, LADDER_ROOT * semis(LADDER_DEGREES[idx]));
  const last = idx === LADDER_DEGREES.length - 1;
  const h = head(g, o, 0.3);

  const env = gain(g, 0);
  env.connect(h);
  const partials = last
    ? [[1, 1], [1.5, 0.28], [2, 0.16], [3, 0.05]]
    : [[1, 1], [2, 0.16], [3, 0.05]];
  for (const [mult, amp] of partials) {
    const vg = gain(g, amp);
    const ov = osc(g, mult === 1 ? 'triangle' : 'sine', f0 * mult, t0, t0 + 0.55 + idx * 0.06);
    ov.connect(vg); vg.connect(env);
  }
  // The transient bypasses `env`: a 1ms tick multiplied by a 5ms attack ramp is
  // inaudible (the ramp is at 8e-5 of peak after 1ms), so the chime would fade
  // in instead of striking.
  tick(g, h, t0, 0.14, 3000, 0.024);
  perc(env.gain, t0, 0.3 + idx * 0.015, 0.005, 0.4 + idx * 0.06);
  return f0;
}

/** Every name in the bank, in declaration order. */
export const NAMES = Object.freeze(Object.keys(BANK));
