// audio/music.js — the score. Owner: audio/ (§1).
//
// TWO LAYERS, ONE TRANSPORT. Everything below the transitions is synthesised,
// as it always was; on top of it sit four recorded beds, permitted by the §0.3
// amendment of 2026-08-07 (`public/audio/*.opus`, at most four tracks, music
// only — every sound EFFECT is still generated in code).
//
//   synth layer   the beds this module has always played. NOT a fallback that
//                 rots: it is what covers the 0.4–2.0s before a file has been
//                 fetched and decoded (start instantly on the gesture, hand off
//                 when the buffer lands — no dead air, no spinner), and it is
//                 the whole score when a fetch fails or the player is offline.
//                 tools/audiotest.mjs renders it and asserts it, still.
//   file layer    lobby / match-1 | match-2 / final-approach, loaded lazily and
//                 never all at once (see LOAD POLICY).
//
// ── AUTOPLAY (§7, §10) ─────────────────────────────────────────────────────
// This module builds nothing at import time, holds no AudioContext, and issues
// no network request until engine.init() hands it a graph from a real
// pointerdown. Under the harness recorder it never starts at all.
//
// ── LOAD POLICY (§0.3 amendment) ───────────────────────────────────────────
// "Nothing on first paint. A session pays for one lobby + one match + at most
// one climax, never the set."
//   lobby           fetched on the first gesture, when the menu bed starts
//   match-1|2       ONE of the two, chosen at game start from a per-match key
//                   and never rotated inside a match — the scarcity is the
//                   point: the in-match music changes exactly once, when Final
//                   Approach arms, so that change lands as an EVENT
//   final-approach  prefetched when any seat reaches TWO sets, so the buffer is
//                   resident before §3.10 can arm
// Buffers are evicted across the lobby/match boundary (see release()), because
// the synth layer covers a re-decode by construction and 30MB of AudioBuffer a
// player cannot hear is 30MB.
//
// ── ONE KEY, TWO BEDS, ONE PEDAL ───────────────────────────────────────────
// Everything synthesised is A natural minor, and that is not a taste decision:
// the final-approach tension bed in engine.js runs a 41.2Hz sub, E1 — the
// DOMINANT of A minor. So when §3.10 arms, the score does not have to stop and
// get out of the way; the match bed drops its root and leaves the fifth, the
// tension bed's E1 reinforces it, and the harmony sits on an unresolved
// dominant pedal for exactly as long as the final approach lasts.
//
//   menu   Am | F | G | Am ‖ Dm | F | E | Am, 66bpm, pad + bugle + brushed
//          backbeat + a gated 4kHz air layer
//   match  A1 + E2 under a slow two-stroke pulse and a 4-bar i–VI–i breath
//   armed  match root fades, E pedal remains, engine.js's tension clock enters
//
// ── THE FOUR TRANSITIONS ───────────────────────────────────────────────────
// They are four different problems and they get four different answers. See
// TRANSITIONS below; the short version is that none of them is a linear fade.
//
// ── SONIC IDENTITY ─────────────────────────────────────────────────────────
// §6's "night flight line": crisp, physical, a little military-formal. The
// synthesised instruments are the SAME primitives as the card sounds — the
// brass is the fanfare's trick (a lowpass tracking the envelope over a sawtooth
// stack), the backbeat is the same brushed noise burst as a card sliding on
// felt, the pad is the sour cue's oscillator pair with the tritone taken out.

import * as clock from '../core/clock.js';
import { makeRng } from '../core/rng.js';
import { dbToGain, clamp, EPS, perc, swell, glide } from './dsp.js';

/* ── the plan ───────────────────────────────────────────────────────────── */

const A2 = 110.0;                       // tonic. Everything is a ratio of this.
const SEMI = Math.pow(2, 1 / 12);
function st(n) { return Math.pow(SEMI, n); }

/** A natural minor scale degrees, in semitones from A. */
const MINOR = [0, 2, 3, 5, 7, 8, 10];

const BPM = 66;                         // a walk, not a march
const BEAT = 60 / BPM;                  // 0.909s
const BAR = BEAT * 4;                   // 3.636s

/**
 * Am | F | G | Am — Aeolian, with the bVI–bVII approach that reads ceremonial
 * rather than sad. Each entry is [root semitones from A, third, fifth]; the
 * voicing drops the third out of the pad and keeps open fifths, which is what
 * stops a sustained pad from sounding like a pop chord.
 */
/* ── EIGHT BARS, NOT FOUR (§P9 FEEL round 3) ───────────────────────────────
 *
 * MEASURED on the 60s menu render: autocorrelation r=0.98 at 14.5s — a
 * near-LITERAL repeat of the block, every 14.5s, on the screen the player sits
 * on before every single game. The bugle motif does vary per phrase, but the
 * pad is four fifths of the level and the pad was the thing repeating: four
 * bars of chords, then exactly those four bars again.
 *
 * A second sentence answers the first instead of repeating it. Bars 5-8 are the
 * same cadence displaced — Dm and E (the minor dominant's major third is the
 * only accidental in the piece, and it is what makes bar 8 want bar 1) — so the
 * literal period is 29.1s rather than 14.5s, and the harmony under the motif is
 * different on the repeat rather than identical. Two sentences is also what the
 * bugle's `index % 4 === 0` motif reroll was already assuming.
 */
const PROGRESSION = [
  [0, 3, 7],      // Am    ┐
  [-4, 4, 7],     // F     │ first sentence — the question
  [-2, 4, 7],     // G     │
  [0, 3, 7],      // Am    ┘
  [-7, 3, 7],     // Dm    ┐
  [-4, 4, 7],     // F     │ second sentence — the answer, and it lands
  [-5, 4, 7],     // E     │ elsewhere before turning back
  [0, 3, 7],      // Am    ┘
];

/**
 * Five bugle shapes, in scale degrees. The scheduler picks one per phrase and
 * transposes it into the current chord, so a 4-bar phrase is 14.5s and the
 * shape sequence does not repeat for 5 phrases (72s) — long enough that the
 * menu has no audible loop point at the time anyone spends on it (measured
 * median time on the home screen in tools/playtest.mjs: 4.1s).
 */
const MOTIFS = [
  [[0, 0], [4, 1.0]],
  [[4, 0], [2, 0.75], [0, 1.5]],
  [[0, 0], [2, 0.5], [4, 1.0]],
  [[7, 0], [4, 1.25]],
  [[0, 0], [-3, 1.0], [0, 1.75]],
];

/* ── THE RECORDED BEDS ───────────────────────────────────────────────────
 *
 * ── LOOPING, AND WHAT WAS ACTUALLY MEASURED ───────────────────────────────
 * All four tracks are three-minute (90s for the climax) COMPOSED PIECES, not
 * loops, and every one of them was measured to fade in from and out to digital
 * silence. Head/tail RMS, 50ms windows, decoded at 48k:
 *
 *   lobby           0.00s -93.2 dBFS   …   -0.05s -90.8 dBFS
 *   match-1         0.00s -95.5 dBFS   …   -0.05s -93.3 dBFS
 *   match-2         0.00s -12.7 dBFS   …   -0.05s -87.7 dBFS
 *   final-approach  0.00s -72.8 dBFS   …   -0.05s -94.8 dBFS
 *
 * A naive `source.loop = true` therefore inserts three to ten seconds of NEAR
 * SILENCE at every seam — match-2 alone would butt a -87.7dB tail against a
 * -12.7dB head, a 75dB step. Every track needs an interior region, and it needs
 * a crossfade at the join, because the interiors do not butt cleanly either.
 *
 * The region per track was chosen by an exhaustive search over (start, end)
 * pairs scoring the 1.5s of spectral context leading up to each — the join is
 * seamless when the run-up to the end resembles the run-up to the start — then
 * graded by RENDERING three crossfaded loop iterations and measuring the
 * spectral flux across the seam against the distribution of the same track's
 * own 1-second flux. A join that sits at the 20th percentile is a smaller
 * change than a median musical moment in the same piece.
 *
 *   track           loopStart  loopEnd  period   xfade  seam flux percentile
 *   lobby              5.272s  61.272s  56.000s   2.5s   6.6%   (p50 0.4946)
 *   match-1           34.504s  98.504s  64.000s   2.0s  20.0%   (p50 0.3891)
 *   match-2           13.520s  45.520s  32.000s   2.0s  29.3%   (p50 0.6299)
 *   match-3           18.198s  47.289s  29.091s  2.727s  22.6%   (p50 0.6596)
 *   match-4           10.944s  40.035s  29.091s  2.727s  24.4%   (p50 0.7059)
 *   final-approach    19.093s  52.075s  32.982s   2.5s   5.1%   (p50 0.5360)
 *
 * The lobby row is the SECOND lobby track and every number in it was re-derived
 * from scratch, not carried over: the first one (ambient) was replaced on
 * 2026-08-07 by a sequencer score because it read too peaceful against the
 * synth bed it stands in for. Nothing about the old file survives here — the
 * region moved 17.579→5.272, the period 80.1s→56.0s, the trim +2.0→−5.6dB, and
 * the grid appeared out of nothing (below). Level step across the new seam is
 * +0.74dB; the best-scoring alternative region was 7.0% but stepped 4.81dB, and
 * a step is what a listener sitting on a menu actually notices.
 *
 * `bar` is the track's measured bar length, or 0 when it has none. A comb
 * filter over the low-band onset envelope, in 20s chunks across each track:
 *   match-1  60.00 bpm in 5 of 7 chunks, 120.00 (the 8ths) in the other 2
 *   match-2  60.00 / 120.00 in 7 of 7
 *   final    51–80 bpm, a different answer every chunk — no stable pulse
 *
 * MATCH-3 AND MATCH-4 were both prompted at 66 BPM, and unlike the lobby the
 * prompt turned out to be the truth — but only the low band says so cleanly, so
 * it was measured the same careful way. A fine comb over BAR lengths 2–8s puts
 * match-4's best at 3.636s (score 0.837, the top of its sweep) and match-3's
 * second at 3.636s (0.626), and the targeted test agrees in BOTH the low and
 * full bands on the same period AND the same phase for match-3 (1.3813s). That
 * is 66.01 BPM in 4/4 — which is to say these two beds share the synthesised
 * score's OWN bar (BEAT*4 = 3.63636s at BPM 66), the first recorded beds that
 * do. Their xfade is three beats (2.7273s) rather than a round number for the
 * usual reason: 29.091 − 2.727 = 26.364s is 29 whole beats, so nothing flams
 * across the overlap.
 *
 * The LOBBY needed a better instrument than chunk-wise comb, which answered
 * 50–56 bpm in every chunk — all of them at the bottom edge of the search range,
 * which is what a comb does when the real period is longer than the range. A
 * normalised autocorrelation of the onset envelope over lags 0.1–9s found the
 * structure instead: a dominant peak at 0.1280s (r 0.0746) with harmonics at
 * 0.248 / 0.376 / 0.752 / 1.499, i.e. SIXTEENTHS at 120bpm — the arpeggiated
 * sequencer line — and a second strong peak at 4.0027s (r 0.0352). That is a
 * 4.000s bar, the same as the two match beds, and a fine comb confirms the
 * phase at 1.2720s. So three of the five beds now carry a real grid and only
 * the climax falls back to the synth transport. See atDownbeat().
 *
 * WHY xfade IS 2.5 HERE AND 2.0 ON THE MATCH BEDS: the same rule, applied to a
 * different pulse. 56.000 − 2.5 = 53.5s is a whole number of the 0.5s beats AND
 * of the 0.125s sixteenths the sequencer runs, so the arpeggio does not flam
 * across the overlap. X=1.0 scored better on flux (0.9th percentile) and was
 * rejected on level: it stepped −3.06dB where 2.5 steps +0.74.
 *
 * WHY THE MATCH BEDS' xfade IS 2.0 AND NOT 2.5. During a loop crossfade the two
 * copies are (period − xfade) apart in the source, so the overlap is rhythmic
 * only if that number is a whole number of beats. 64.000 − 2.0 = 62.0 and
 * 32.000 − 2.0 = 30.0 are both whole beats at 60bpm, so the pulses land
 * together; 2.5 would put them 500ms apart, which is a flam, which is the one
 * artifact a listener names instantly. (A whole number of BARS — 4.0s — would
 * align the accents too, but it measured worse on the seam: 45.0% and 58.7%
 * against 20.0% and 29.3%. Half a bar of displaced accent inside a 2s window is
 * a hemiola; a flam is a mistake.)
 */
const TRACKS = Object.freeze({
  lobby: {
    file: 'lobby.opus', loopStart: 5.272, loopEnd: 61.272, xfade: 2.5,
    bar: 4.0, trimDb: -4.0,
  },
  match1: {
    file: 'match-1.opus', loopStart: 34.504, loopEnd: 98.504, xfade: 2.0,
    bar: 4.0, trimDb: -6.3,
  },
  match2: {
    file: 'match-2.opus', loopStart: 13.520, loopEnd: 45.520, xfade: 2.0,
    bar: 4.0, trimDb: -7.8,
  },
  match3: {
    file: 'match-3.opus', loopStart: 18.198, loopEnd: 47.289, xfade: 2.7273,
    bar: 3.63636, trimDb: -10.0,
  },
  match4: {
    file: 'match-4.opus', loopStart: 10.944, loopEnd: 40.035, xfade: 2.7273,
    bar: 3.63636, trimDb: -13.0,
  },
  final: {
    file: 'final-approach.opus', loopStart: 19.093, loopEnd: 52.075, xfade: 2.5,
    bar: 0, trimDb: -10.7,
  },

  /* ── THE ENDGAME PAIR (§0.3 amended 2026-08-07 (c), cap four → six) ───────
   *
   * Not beds. One-shots, 39.97s each, and the ONLY tracks here with no loop
   * region: they are meant to end. MEASURED, both of them, and this is why
   * there is no tail fade — they end in digital silence on their own. Last 50ms
   * RMS: victory −90.3 dBFS, defeat −95.7; last sample 7.0e-6 and 6.4e-6; worst
   * one-sample step inside the final 20ms 1.16e-4 and 2.94e-5. Nothing to fade.
   *
   * Their HEADS are opposite and both are right for what they sit under. The
   * fanfare and defeat STINGS fire on the same instant at −4.2 and −4.6 dBFS,
   * so the recording is the thing under the sting, not the thing announcing it:
   *   victory  −92.9 dBFS at 0.00s, −33.2 at 2s, −14.3 at 5s — a five-second
   *            swell that arrives as the fanfare rings out
   *   defeat   −97.6 at 0.00s, −12.8 at 1.00s — one hit, then it settles
   *
   * `holds` is the supersede rule and it is the whole design (see startCeremony):
   *   victory 'menu'  survives every menu-side screen change — the win overlay,
   *                   Rematch into a lobby, back to the main menu — and yields
   *                   only to a match actually starting.
   *   defeat  'none'  ends when the player leaves the overlay. The asymmetry IS
   *                   the respect: a win is something you carry out with you, a
   *                   loss is acknowledged and then closed. Following someone
   *                   into the lobby with their own defeat music is the
   *                   "mocking" §7's brief rules out, and it is the one thing
   *                   nobody could turn off without turning off all music.
   */
  victory: { file: 'victory.opus', oneShot: true, holds: 'menu', bar: 0, trimDb: -2.4 },
  defeat: { file: 'defeat.opus', oneShot: true, holds: 'none', bar: 0, trimDb: 2.1 },
});

/* FOUR beds, and the fourth is the point. §0.3's cap went to eight for these.
 * A fair pick over two means a player hears the same bed twice running half the
 * time, which is what "there is only one track" actually was — see
 * pickMatchTrack(), which is where the no-repeat rule lives. */
const MATCH_TRACKS = ['match1', 'match2', 'match3', 'match4'];

/* ── module state ───────────────────────────────────────────────────────── */

let g = null;                           // the engine's graph handle, or null
let mix = null;                         // the music bus — see buildMix()
let sub = null;                         // clock subscription
let rng = makeRng('chudopoly-music');

let mode = 'off';                       // off | menu | match
let want = 'off';                       // what the app asked for, even if muted
let enabled = true;
/* 1.0, not 0.7. Every offline render in tools/audiotest.mjs measures the mix at
 * unity, so making unity the default is what makes the gate measure the thing
 * that ships. It also stops the music from starting 3.1dB under the level its
 * trims were derived at. A returning player keeps whatever they saved. */
let level = 1;
let tension = false;

let nextBar = 0;                        // absolute context time of the next bar
let bar = 0;                            // bar counter since start
let motif = 0;
let nextSwell = 0;                      // next hangar-air swell
let synthLive = true;                   // is the synth layer the bed right now?
let synthOffAt = 0;                     // …and when a handoff finishes taking it
let synthUpAt = 0;                      // …and when it is first due to be HEARD

// Persistent nodes of the match drone, so arming can fade one voice out without
// rebuilding anything.
let drone = null;

// CPU accounting, reported by stats().
let nodesMade = 0;
let pumps = 0;
let pumpMs = 0;

/* file layer */
const buffers = new Map();              // key → trimmed AudioBuffer
const loading = new Map();              // key → Promise<AudioBuffer|null>
const failed = new Set();               // key → the fetch/decode lost; synth stays
let voices = [];                        // live file sources, oldest first
let matchTrack = null;                  // which of the four, this match
let lastBed = null;                     // …and the one before it — see pickMatchTrack()
let matchKey = '';                      // the per-match seed for that choice
let bedWant = null;                     // which track SHOULD be the bed
let pendingArm = false;                 // armed before the climax buffer landed
let ceremony = null;                    // the endgame one-shot, if one is playing
/* Bumped every time a match BEGINS. A ceremony fetch that resolves late must
 * not interrupt a game that started while it was in flight — but "are we in
 * match mode" is the wrong question to ask, because you win while still looking
 * at the game screen, so mode IS 'match' at the moment ending() is called. That
 * mistake cost a live round: the cue loaded and never played. */
let matchSeq = 0;
let busyUntil = 0;                       // no new transition lands before this

const LOOKAHEAD = 0.45;                 // schedule this far ahead of the clock
/* How long the synthesised fallback waits before it makes itself heard.
 *
 * 0.45 was set against a warm localhost fetch+decode of 176ms and it was too
 * tight for a real first load: the owner, on a COLD cache, "still heard like an
 * old synthesized synth… played for a second". A first-gesture fetch of a 1.4MB
 * file plus a 3-minute Opus decode is comfortably past 450ms on a real browser
 * even when the server is localhost, so the fallback showed itself and then had
 * to leave again — which is the one thing it exists not to do.
 *
 * 1.4s, and the cost of being wrong is asymmetric: waiting means a beat of
 * silence after a click, which reads as the music starting; NOT waiting means a
 * completely different piece of music plays and is then taken away, which reads
 * as a bug. A player who is actually offline does not pay it either — a failed
 * fetch rejects in milliseconds and skips straight to the synth (see raiseBed). */
const SYNTH_GRACE = 1.4;
const FADE = 0.7;                       // bed crossfades

/* ── levels ──────────────────────────────────────────────────────────────
 *
 * ── THE OWNER COULD NOT HEAR IT (§P10 round 2) ────────────────────────────
 * On the first build, at 100% music and 70% sfx: "cant really hear anything at
 * all music wise". The trims that produced that were derived to hold each bed's
 * PEAK under card_slide's peak, which is what tools/audiotest.mjs asserted, and
 * that assertion is now gone — see the note on assertion 6 there. Every number
 * below is re-derived against a MASKING criterion instead: a bed may be as loud
 * as it likes until it comes within 6dB of a §7 card cue in that cue's own
 * loudest octave. All four in-match beds sit within a decibel of that floor, so
 * this is as loud as the music can be without taking the card layer, and the
 * next decibel would have to be bought from the cards.
 *
 * MEASURED, 24s render at unity, by octave, against the first build:
 *   match-1   250 +5.0  500 +9.8   1k +11.4  2k +11.6  4k +11.7 dB
 *   match-2   250 +7.4  500 +10.7  1k +13.4  2k +13.7  4k +13.7
 *   final     250 +0.7  500 +4.3   1k +6.7   2k +7.0   4k +7.0
 *   lobby     250 +3.7  500 +6.9   1k +9.8   2k +10.1  4k +10.1
 * The broadband RMS moved far less than that (+5.5 on match-1) and the
 * broadband number is the misleading one: the shelf in buildMix() moved the
 * beds' energy OUT of the octave no laptop reproduces and into the octaves that
 * carry, which is where the +11dB is.
 *
 * MENU_TRIM / MATCH_TRIM are the synthesised beds' own trims, so the synth and
 * the recording it hands off to are the same loudness — they were 7.8dB apart
 * on the first build, which is an audible step at the handoff. They are not a
 * change to `level`, which is the player's volume and applies to everything.
 *
 * DRONE_GAIN is unchanged at 0.045: the match bed gains a shape, not a level;
 * MATCH_TRIM is where its level lives.
 */
const MENU_TRIM = 2.76;
const MATCH_TRIM = 2.85;
const DRONE_GAIN = 0.045;

/* ── THE MUSIC'S OWN ROOM (§P10 fix 1) ────────────────────────────────────
 *
 * MEASURED before this: zero references to the reverb send anywhere in this
 * module. Every voice ran dry into preMaster while every card sound had a
 * room — so the score was the only thing in the game that sounded like it was
 * being played inside a headphone rather than inside the hangar.
 *
 * It does not get the card table's IR. That one is deliberately small
 * (dsp.js:121 — 0.55s, decay 4.6, sized so a five-card payment does not smear
 * into one wash) and a pad through it reads as a dry pad with a tick on it.
 * The music bus gets a SECOND impulse, 2.2s / decay 3.2, built and cached by
 * engine.js exactly like the first (g.musicIr).
 *
 * Send −9dB, returned at −7dB through a 220Hz highpass: the highpass is what
 * keeps the 55Hz root and the pulse out of the tail, because a 2.2s reverb on a
 * sub is mud and nothing else. The send is tapped POST-duck, so the room ducks
 * under a sting with the music instead of ringing on over it.
 */
const MUSIC_SEND_DB = -9;
const MUSIC_RETURN_DB = -7;
const MUSIC_VERB_HP = 220;

/** The match pulse, in beats of the bar. §7: no kick drum — this is a swelled
 *  68→40Hz stroke through a 150Hz lowpass, felt rather than heard, and 1 and 3
 *  put it at 33 strokes a minute. A resting heart rate, which is the tempo of
 *  "pre-flight, before dawn". */
const MATCH_PULSE = [[0, 0.024], [2, 0.016]];
const MATCH_PHRASE = 4;                 // bars per breath — the thing that ENDS

/* The presence band's own phrase, per bar of MATCH_PHRASE (see startDrone).
 *
 * This is where the breathing can actually be HEARD, and it swings four times
 * as far as the sub layers do: 0.045 → 0.21 → 0.155 → 0.032 is +13.4dB up to
 * the crest and −16.3dB down to a trough BELOW where the phrase started, which
 * is the asymmetry that makes it a phrase and not a loop (see
 * scheduleMatchBar). The sub layers cannot swing like that — see the note on
 * `to` in scheduleMatchBar — because the bed's PEAK is what tools/audiotest.mjs
 * holds under card_slide and there is under 2dB of room in it.
 *
 * MEASURED, 45s offline render: energy above 300Hz 4.48% → 4.83% of the bed,
 * and the envelope sd of that band 2.6 → 2.7dB. That is an improvement and it
 * is not the 11.4dB the round-3 critique asked for — see the report. */
const AIR_PHRASE = [0.045, 0.21, 0.155, 0.032];

/** The fifth, and where the phrase takes it. E2 is the tonic chord's fifth and
 *  an octave above the §3.10 tension sub; F2 is the VI, and moving between them
 *  is the entire harmonic content of the match bed — which is the right amount
 *  for something that has to stay under the card layer for 150 seconds. */
const E2_HZ = A2 * st(7) * 0.5;         // 82.4Hz
const F2_HZ = A2 * st(8) * 0.5;         // 87.3Hz

/* ── plumbing ───────────────────────────────────────────────────────────── */

/* ── THE POCKET (§P10 round 2) ────────────────────────────────────────────
 *
 * The owner's verdict on the first build was "cant really hear anything at
 * all music wise", and the octave-band measurement says exactly why and
 * exactly where. Every card cue that must cut through the bed has its
 * dominant energy in the 250Hz band — card_snap −37.8 dB, deal_done −39.8,
 * shuffle_riffle −39.1, prop_place −32.6 — and so does every music bed:
 * match-1 −51.1, match-2 −53.0, final-approach −49.9, and the synthesised
 * bed −56.1. The music and the card thumps were fighting over one octave.
 *
 * So the bed gets EQ'd out of the way rather than turned down — but only where
 * the collision actually is.
 *
 * ── IT WAS A SHELF AND THAT WAS TOO BLUNT (§P10 round 4) ─────────────────
 * The first version was a lowshelf at 380Hz, −8dB, which took the weight out
 * of every octave below the collision as well as the collision itself. Owner:
 * "the tracks sound much weaker/less impactful than they did initially… they
 * sounded much better on the preview." MEASURED against the raw .opus files,
 * per octave, referenced to 2kHz so only the SHAPE is compared:
 *
 *              63Hz   125Hz  250Hz  500Hz   1k
 *   lobby      −7.3   −7.2   −6.6   −2.2   −0.3 dB
 *   match-1    −6.5   −7.3   −6.5   −2.0   −0.3
 *   final      −6.6   −7.2   −6.1   −2.5   −0.3
 *
 * Seven decibels of weight gone at 63 and 125Hz — and NOT ONE card cue has
 * its dominant energy below 180Hz, so those two octaves bought nothing at all.
 * A peaking cut centred in the band that does collide keeps the clearance and
 * gives the weight back. MEASURED after, same reference:
 *
 *              63Hz   125Hz  250Hz  500Hz   1k
 *   lobby      +1.2   −1.0   −6.0   −2.0   −0.4 dB
 *   match-1    +0.6   −1.6   −6.1   −1.8   −0.4
 *   final      +0.4   −1.5   −5.5   −2.3   −0.4
 *
 * Seven decibels of weight returned at 63 and 125Hz for six tenths of a decibel
 * at the collision, which −8dB rather than −7 then buys back. The highpass
 * drops 45 → 32Hz for the same reason: at 45 it was second-guessing the 63Hz
 * octave. NOTHING was taken from the card layer to do this, and the masking
 * floor did not move. */
const MUSIC_NOTCH_HZ = 250;
const MUSIC_NOTCH_Q = 1.1;
const MUSIC_NOTCH_DB = -8;

/**
 * The music bus. One object so offline() can swap the whole thing atomically.
 *
 *   synth voices → synth(trim) → synthLp → synthEnv ─┐
 *   file voices  ────────────────────────→ file ─────┤
 *   stinger/riser ───────────────────────→ fx ───────┴→ master(volume) → duck ─┬→ musicBus
 *                                                                              │
 *                                            └→ send → musicIr → HP220 → return┘
 *
 * FOUR inputs and not one, because the transitions automate them against each
 * other. `synthEnv` is the synth bed's transition envelope and `synth` is its
 * per-mode trim — separate nodes because a mode change and a transition both
 * want to write the synth layer's level and one AudioParam cannot hold two
 * automation curves. `fx` carries the stinger and the riser, which must NOT be
 * inside the envelope that is fading the bed out underneath them; that was the
 * bug the split exists to make impossible.
 */
function buildMix(graph, volume) {
  const ctx = graph.ctx;
  const m = {};
  m.master = ctx.createGain();
  m.master.gain.value = Math.max(volume, EPS);
  m.duck = ctx.createGain();
  m.duck.gain.value = 1;
  m.synth = ctx.createGain();
  m.synth.gain.value = 1;
  // ART §7's menu exit closes the cutoff to 300Hz as it ramps out. Transparent
  // at rest; a biquad at 18kHz costs one node and changes nothing measurable.
  m.synthLp = ctx.createBiquadFilter();
  m.synthLp.type = 'lowpass';
  m.synthLp.frequency.value = 18000;
  m.synthLp.Q.value = 0.5;
  m.synthEnv = ctx.createGain();
  m.synthEnv.gain.value = 1;
  m.file = ctx.createGain();
  m.file.gain.value = 1;
  m.fx = ctx.createGain();
  m.fx.gain.value = 1;
  m.shelf = ctx.createBiquadFilter();
  m.shelf.type = 'peaking';
  m.shelf.frequency.value = MUSIC_NOTCH_HZ;
  m.shelf.Q.value = MUSIC_NOTCH_Q;
  m.shelf.gain.value = MUSIC_NOTCH_DB;
  m.rumble = ctx.createBiquadFilter();
  m.rumble.type = 'highpass';
  m.rumble.frequency.value = 32;
  m.rumble.Q.value = 0.5;
  m.synth.connect(m.synthLp);
  m.synthLp.connect(m.synthEnv);
  m.synthEnv.connect(m.master);
  m.file.connect(m.master);
  m.fx.connect(m.master);
  m.master.connect(m.shelf);
  m.shelf.connect(m.rumble);
  m.rumble.connect(m.duck);
  m.duck.connect(graph.musicBus);
  if (graph.musicIr) {
    m.send = ctx.createGain();
    m.send.gain.value = dbToGain(MUSIC_SEND_DB);
    m.verb = ctx.createConvolver();
    m.verb.buffer = graph.musicIr;
    m.verbHp = ctx.createBiquadFilter();
    m.verbHp.type = 'highpass';
    m.verbHp.frequency.value = MUSIC_VERB_HP;
    m.verbReturn = ctx.createGain();
    m.verbReturn.gain.value = dbToGain(MUSIC_RETURN_DB);
    m.duck.connect(m.send);
    m.send.connect(m.verb);
    m.verb.connect(m.verbHp);
    m.verbHp.connect(m.verbReturn);
    m.verbReturn.connect(graph.musicBus);
  }
  return m;
}

/** Called by engine.js once the graph exists. Idempotent. */
export function attach(graph) {
  if (!graph || g === graph) return;
  detach();
  g = graph;
  mix = buildMix(graph, 0.0001);
  if (want !== 'off') start(want);
}

export function detach() {
  stopAll(0);
  if (sub) { sub(); sub = null; }
  mix = null;
  g = null;
  mode = 'off';
}

export function setEnabled(on) {
  enabled = !!on;
  if (!enabled) stopAll(0.5);
  else if (want !== 'off') start(want);
}

export function isEnabled() { return enabled; }

export function setVolume(v) {
  level = clamp(Number(v) || 0, 0, 1);
  rampOut();
}

export function getVolume() { return level; }

/**
 * What the app wants playing: 'menu' on home/lobby, 'match' in a game, 'off'
 * when the tab is hidden or sound is off. Safe to call every state broadcast —
 * a request for the mode already playing does nothing.
 *
 * `opts.key` is the per-match seed that picks one of the two match beds. It is
 * read only on the transition INTO 'match'; the amendment's "never rotated
 * mid-match" is that fact.
 */
export function set(which, opts) {
  want = which;
  if (opts && opts.key != null) matchKey = String(opts.key);
  if (which === 'off') { stopAll(FADE); return; }
  start(which);
}

/**
 * Pull a track into memory before it is needed. engine.js calls this with
 * 'final' the moment any seat reaches two complete sets, which is the §0.3
 * amendment's "prefetched when a seat reaches two sets" — by the time §3.10 can
 * arm, the buffer is resident and the transition is a cut rather than a wait.
 */
export function prefetch(key) {
  if (!g || !enabled || !TRACKS[key]) return;
  load(key);
}

/** §3.10 armed/disarmed. This is the loudest transition in the game — see
 *  toFinalApproach() / fromFinalApproach(). */
export function setTension(on) {
  const t = !!on;
  if (t === tension) return;
  tension = t;
  if (!g) return;
  if (t) toFinalApproach();
  else fromFinalApproach();
}

/**
 * Duck the score under a sting. engine.js calls this for every PRIORITY voice
 * (the tier 0/1 moments), which is the whole reason a bed can exist under a
 * card game at all: for the 40% of wall-clock that a real game is making noise
 * the music steps back 7dB, and for the 60% it is silent (measured over a full
 * seeded game: 17 gaps over 1.5s, 89.9s of 150s) the music is the only thing
 * there. It fills the silence and never competes with a consequence.
 */
export function dip(weight) {
  if (!mix || !g || mode === 'off') return;
  const now = ctxNow();
  /* ── THE DUCK GOT SHALLOWER (§P10 round 2) ──────────────────────────────
   * It was 0.34 / 0.45 / 0.55 — 9.4, 6.9 and 5.2dB. On a bed that was already
   * inaudible that was not sidechaining, it was subtraction, and it fires on
   * every priority voice, which over a real game is most of the wall clock the
   * music is not already silent for. 0.50 / 0.60 / 0.70 is 6.0, 4.4 and 3.1dB:
   * still an unmistakable step back on the moments that matter, and it hands
   * roughly 3dB of the bed back to the 60% of a game that has nothing in it.
   * The masking gate is unaffected — it measures the bed UNDUCKED, which is the
   * worst case for the card layer. */
  const depth = weight >= 6 ? 0.50 : weight >= 4 ? 0.60 : 0.70;
  const p = mix.duck.gain;
  p.cancelScheduledValues(now);
  p.setValueAtTime(Math.max(p.value, EPS), now);
  p.linearRampToValueAtTime(depth, now + 0.025);
  p.exponentialRampToValueAtTime(1, now + 0.025 + (weight >= 6 ? 0.6 : 0.28));
}

export function stats() {
  const loaded = [];
  for (const k of buffers.keys()) loaded.push(k);
  return {
    mode, enabled, level, tension,
    nodes: nodesMade,
    pumps,
    // Mean cost of the scheduler callback, in ms per frame. The bed is a
    // lookahead scheduler on core/clock.js (§0.6), so the steady-state frame
    // cost is one float compare; the mean below includes the bars where it
    // actually builds nodes.
    pumpMsMean: pumps ? pumpMs / pumps : 0,
    // The file layer. `synth` true means the synthesised bed is what is
    // audible — before a file lands, or forever if one never does.
    synth: synthLive,
    bed: bedWant,
    track: matchTrack,
    loaded,
    loading: loading.size,
    failed: [...failed],
    fileVoices: voices.length,
    ceremony: ceremony ? ceremony.key : null,
    ceremonyLeft: ceremony ? Math.max(0, ceremony.endAt - ctxNow()) : 0,
    // The synth layer's transition envelope, so "is the synth still under the
    // recorded bed" is answerable from __CHUD without a render.
    synthEnv: mix ? mix.synthEnv.gain.value : 0,
    synthTrim: mix ? mix.synth.gain.value : 0,
  };
}

/* ── the file layer ─────────────────────────────────────────────────────── */

/**
 * Fetch + decode + trim one track. Resolves to null on any failure, which is
 * not an error condition: the synth layer is already playing and stays.
 *
 * The URL is resolved against this module rather than against the document, so
 * it survives being served from a sub-path.
 */
function load(key) {
  if (buffers.has(key)) return Promise.resolve(buffers.get(key));
  const cached = loading.get(key);
  if (cached) return cached;
  const spec = TRACKS[key];
  if (!spec || !g) return Promise.resolve(null);
  if (offlineMode) {
    // A render cannot wait on the network, so the arrival is scheduled instead:
    // offlineTransition() resolves this at the simulated moment the fetch would
    // have landed, with clockOffset set to that moment.
    if (!offlineArrive || offlineArrive[key] == null) return Promise.resolve(null);
    let resolve;
    const p = new Promise((r) => { resolve = r; });
    loading.set(key, p);
    offlinePending.push({ key, at: offlineArrive[key], resolve });
    return p;
  }
  let url;
  try {
    url = new URL(`../../audio/${spec.file}`, import.meta.url).href;
  } catch {
    return Promise.resolve(null);
  }
  const ctx = g.ctx;
  const p = fetch(url, { credentials: 'omit' })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((ab) => ctx.decodeAudioData(ab))
    .then((buf) => {
      const trimmed = trimToLoop(ctx, buf, spec);
      buffers.set(key, trimmed);
      loading.delete(key);
      failed.delete(key);
      return trimmed;
    })
    .catch(() => {
      loading.delete(key);
      failed.add(key);
      return null;
    });
  loading.set(key, p);
  return p;
}

/**
 * Copy [loopStart, loopEnd) out of the decoded track and drop the rest.
 *
 * The composed fade-in and fade-out are DISCARDED on purpose, and not only to
 * save the memory (the lobby track decodes to 69MB and its loop region is
 * 30.8MB). A four-second ramp up from silence is the wrong entrance for a bed
 * that arrives on a bar-aligned stinger; every fade this module plays it
 * schedules itself, against the transport, in the shape the transition asks
 * for. See TRANSITIONS.
 */
function trimToLoop(ctx, buf, spec) {
  // A one-shot has no loop region to cut to and is kept whole: the endgame pair
  // is meant to END, and both were measured ending in digital silence on their
  // own (see TRACKS), so there is nothing to trim and nothing to fade.
  if (spec.oneShot) return buf;
  const sr = buf.sampleRate;
  const a = Math.max(0, Math.round(spec.loopStart * sr));
  const n = Math.min(buf.length - a, Math.round((spec.loopEnd - spec.loopStart) * sr));
  const out = ctx.createBuffer(buf.numberOfChannels, n, sr);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    out.getChannelData(c).set(buf.getChannelData(c).subarray(a, a + n));
  }
  return out;
}

/** Drop buffers for tracks the current mode can never need. See LOAD POLICY. */
function release(keep) {
  for (const k of [...buffers.keys()]) {
    // A ceremony in flight keeps its own buffer whatever the mode thinks: it is
    // a 15MB decode and the source is still reading from it.
    if (ceremony && k === ceremony.key) continue;
    if (!keep.includes(k)) buffers.delete(k);
  }
}

/**
 * Start one pass of a track. Each pass is its own source; the loop is a
 * CROSSFADE between two of them (reloop(), below), because none of the four
 * tracks butt-joins cleanly — see THE RECORDED BEDS.
 *
 *   source → lowpass → gain → mix.file
 *
 * The lowpass is transparent at rest (18kHz) and exists so a transition can
 * close it: ART §7's menu exit is "an 800ms exponential ramp to silence AND
 * cutoff → 300Hz", and a bed that only loses level reads as a volume knob.
 */
function startFile(key, at, opts) {
  const spec = TRACKS[key];
  const buf = buffers.get(key);
  if (!spec || !buf || !g || !mix) return null;
  const ctx = g.ctx;
  const src = ctx.createBufferSource();
  nodesMade++;
  src.buffer = buf;
  const lp = ctx.createBiquadFilter();
  nodesMade++;
  lp.type = 'lowpass';
  lp.frequency.value = opts.lp || 18000;
  lp.Q.value = 0.5;
  const vg = ctx.createGain();
  nodesMade++;
  vg.gain.value = 0.0001;
  src.connect(lp); lp.connect(vg); vg.connect(mix.file);
  const t0 = Math.max(at, ctx.currentTime + 0.005);
  src.start(t0);
  const period = buf.duration;
  const v = {
    key, spec, src, lp, gain: vg,
    startAt: t0, endAt: t0 + period, period,
    level: dbToGain(spec.trimDb),
    stopping: false,
  };
  src.stop(v.endAt + 0.05);
  src.onended = () => { v.dead = true; };
  const fade = opts.fade == null ? 0.04 : opts.fade;
  if (fade <= 0.001) {
    vg.gain.setValueAtTime(v.level, t0);
  } else {
    fadeParam(vg.gain, t0, fade, 0.0001, v.level, 'in');
  }
  if (opts.lp && opts.lpTo) glide(lp.frequency, t0, opts.lp, opts.lpTo, opts.lpDur || fade);
  voices.push(v);
  /* VOICE CAP. A crossfade needs exactly two — one going, one coming — and every
   * ordinary path here creates the second and immediately stops the first. A
   * player toggling in and out of a game faster than the fades can finish stacks
   * them instead: MEASURED at a 1.15s leave/rejoin cadence, nine full beds
   * playing at once. It drains (the reaper is fine, and a realistic 6.5s cadence
   * never exceeds one voice) but nine beds at once is not a crossfade, it is a
   * mix, and it is nine buffers of level nobody asked for. Anything older than
   * the outgoing pair is retired at once; it is already inaudible under the two
   * on top of it. */
  // ctxNow(), not t0: the new voice's start is bar-aligned and can be a second
  // or more in the future, and retiring the pile-up THEN is not retiring it.
  for (let i = 0; i < voices.length - 3; i++) retire(voices[i], ctxNow());
  note(`startFile ${key} at ${t0.toFixed(3)} fade ${fade} level ${v.level.toFixed(4)} period ${period.toFixed(3)}`);
  return v;
}

/** The lead file voice — the newest one that is not on its way out. */
function leadVoice() {
  for (let i = voices.length - 1; i >= 0; i--) {
    if (!voices[i].stopping && !voices[i].dead) return voices[i];
  }
  return null;
}

/** Hard-retire a voice that is already on its way out. stopVoice() deliberately
 *  no-ops on a voice that is stopping, which is right for a crossfade and wrong
 *  for a pile-up: the ones stacking are all mid-fade, so nothing short of this
 *  shortens them. */
function retire(v, at) {
  if (!v || v.retired || v.dead) return;
  v.retired = true;
  v.stopping = true;
  const t = Math.max(at, ctxNow());
  note(`retire ${v.key} at ${t.toFixed(3)}`);
  fadeParam(v.gain.gain, t, 0.1, v.gain.gain.value, 0.0001, 'out');
  try { v.src.stop(t + 0.13); } catch { /* already scheduled */ }
  v.endAt = Math.min(v.endAt, t + 0.13);
}

function stopVoice(v, at, dur, shape) {
  if (!v || v.stopping) return;
  v.stopping = true;
  const t = Math.max(at, ctxNow());
  note(`stopVoice ${v.key} at ${t.toFixed(3)} over ${dur} (${shape || 'out'})`);
  fadeParam(v.gain.gain, t, dur, v.level, 0.0001, shape || 'out');
  try { v.src.stop(t + dur + 0.03); } catch { /* already scheduled to stop */ }
  v.endAt = Math.min(v.endAt, t + dur + 0.03);
}

/** Every file voice out over `dur`, equal-power. */
function stopFiles(at, dur, shape) {
  for (const v of voices) stopVoice(v, at, dur, shape);
}

/**
 * The loop. `xfade` seconds before the lead voice runs out of buffer, start the
 * next pass and equal-power crossfade into it. Called from pump(), so it is on
 * core/clock.js (§0.6) like everything else here.
 */
function reloop(now) {
  const v = leadVoice();
  if (!v || v.key !== bedWant) return;
  const x = v.spec.xfade;
  const at = v.endAt - x;
  if (now + LOOKAHEAD < at) return;
  if (v.relooped) return;
  v.relooped = true;
  // Returned from a hidden tab after the source already ran out: no crossfade
  // to schedule, just get the bed back with a short fade rather than leave the
  // player in silence.
  const late = now > v.endAt;
  const t = late ? now + 0.02 : at;
  const nv = startFile(v.key, t, { fade: late ? 0.35 : x });
  if (!nv) return;
  stopVoice(v, t, late ? 0.05 : x, 'out');
}

/* ── equal-power fades ──────────────────────────────────────────────────── */

/**
 * Fade one AudioParam along an equal-power curve, as 16 linear segments.
 *
 * Sixteen segments rather than setValueCurveAtTime because a value CURVE throws
 * NotSupportedError if any other automation event lands inside its window, and
 * this module reschedules transitions on top of each other by design (an arm
 * broken one bar after it armed). Peak deviation from cos/sin at N=16 is 0.48%
 * = 0.04dB, which is four hundred times below anything audible.
 *
 * Equal power and not linear: two linear ramps summed dip 3dB in the middle,
 * and a 3dB hole in the middle of every bed change is exactly the "dissolve"
 * these transitions are written to avoid.
 */
function fadeParam(param, t0, dur, from, to, shape) {
  const t = Math.max(t0, ctxNow());
  cancelFrom(param, t);
  param.setValueAtTime(Math.max(from, 0), t);
  const N = 16;
  for (let i = 1; i <= N; i++) {
    const u = i / N;
    const w = shape === 'out' ? Math.cos(u * Math.PI / 2)
      : shape === 'in' ? Math.sin(u * Math.PI / 2)
        : u;
    const v = shape === 'out' ? to + (from - to) * w : from + (to - from) * w;
    param.linearRampToValueAtTime(Math.max(v, 0), t + dur * u);
  }
}

/** cancelScheduledValues drops a ramp's END event and so teleports the value to
 *  wherever the last setValueAtTime left it. cancelAndHoldAtTime is the one
 *  that keeps the value it had at `t`; fall back where it does not exist. */
function cancelFrom(param, t) {
  if (typeof param.cancelAndHoldAtTime === 'function') {
    try { param.cancelAndHoldAtTime(t); return; } catch { /* fall through */ }
  }
  param.cancelScheduledValues(t);
}

/* ── the transport ──────────────────────────────────────────────────────── */

/**
 * The transport clock. `clockOffset` is zero in every shipped path and nonzero
 * only inside offlineTransition(), where an OfflineAudioContext's currentTime
 * stays pinned at 0 for the whole of scheduling — without it a transition
 * render could only ever measure the first instant of the timeline.
 */
let clockOffset = 0;
let offlineMode = false;              // offlineTransition() only — see below
/* Deterministic buffer ARRIVAL, offline only. Every gate before this one
 * rendered with the buffers already resident, which exercises raiseBed()'s fast
 * path and never once ran handoff() — the path a real player takes on the first
 * gesture of every session. These two let a render say "this track shows up at
 * t=0.2s" and drive the real load()→then→crossToFile() chain against it. */
let offlineArrive = null;
const offlinePending = [];
let offlineLog = null;                // …and the score it wrote, for the harness
function note(what) { if (offlineLog) offlineLog.push(`${clockOffset.toFixed(2)} ${what}`); }
function ctxNow() { return g ? g.ctx.currentTime + clockOffset : 0; }

/**
 * The next musical downbeat at or after `after`.
 *
 * WHICH grid: the lead recorded bed's, when it has one. Only the two match beds
 * do (4.000s, measured — see THE RECORDED BEDS); the lobby and climax beds are
 * ambient and a comb filter finds a different tempo in every 20s chunk of them,
 * so there is nothing there to land on and the synth transport's own bar
 * (3.636s at 66bpm) is the grid instead. That is not a fudge: the stinger and
 * the riser ARE synth voices, so on a beatless bed the synth bar is the only
 * musical time in the room.
 *
 * ── WAITING FOR THE BAR IS ITSELF THE DELAY (§P10 round 2) ─────────────────
 * The owner's verdict on the first build was that the transitions "take too
 * long", and the arithmetic agrees: a full 3.636s bar on the synth transport
 * put up to 3.6 SECONDS between the event and the sound of it, before any fade
 * had even started. So the grid is chosen by whether there is a real one:
 *
 *   a recorded bed with a measured bar (the two match beds, 4.000s) — align to
 *     ITS bar, because that bar is a real musical fact about what is playing.
 *   anything else — the transport's 3.636s bar is ARBITRARY relative to a
 *     beatless lobby or climax track (both measured: no stable tempo, a
 *     different answer in every 20s chunk), so its half-bar is exactly as
 *     musical and half the wait.
 *
 * `maxWait` bounds the lateness past that — a transition that waits longer than
 * its own fade has stopped being a response to the event that caused it. Past
 * the bound we halve the grid again, to the beat.
 */
function atDownbeat(after, maxWait) {
  const v = leadVoice();
  let grid, origin;
  if (v && v.spec.bar > 0) {
    grid = v.spec.bar;
    origin = v.startAt;
  } else {
    grid = BAR / 2;
    origin = nextBar;
    while (origin > after) origin -= grid;
  }
  const k = Math.ceil((after - origin) / grid - 1e-6);
  let t = origin + k * grid;
  // Halve the grid until the wait fits, down to the beat (a quarter of a 4/4
  // bar) and no further: past that it is not alignment, it is "now".
  for (let div = 2; maxWait && t - after > maxWait && div <= 4; div *= 2) {
    const fine = grid / div;
    const cand = origin + Math.ceil((after - origin) / fine - 1e-6) * fine;
    if (cand >= after) t = cand;
  }
  return Math.max(t, busyUntil, after);
}

function rampOut() {
  if (!g || !mix) return;
  const now = ctxNow();
  const target = enabled && mode !== 'off' ? Math.max(level, 0.0001) : 0.0001;
  const p = mix.master.gain;
  p.cancelScheduledValues(now);
  p.setValueAtTime(Math.max(p.value, EPS), now);
  p.exponentialRampToValueAtTime(target, now + FADE);
}

/** MENU_TRIM is §7's −14 dBFS master, and it is a property of the synthesised
 *  BED, not of the player's volume — which is why it lives here and not on
 *  `master`, and why the match bed (which must stay under card_slide) and the
 *  recorded beds (which carry their own measured trim) are untouched by it. */
function synthTrim() { return mode === 'menu' ? MENU_TRIM : MATCH_TRIM; }

/* ── TRANSITIONS ─────────────────────────────────────────────────────────
 *
 * Four of them, and each one is a different question. Solving all four with one
 * linear crossfade is the failure ART §7 names by name.
 *
 *  1. lobby → match      the game starting. ART §7: "bar-aligned V→i stinger +
 *                        noise riser (500ms) with an 800ms exponential ramp to
 *                        silence and cutoff → 300Hz. Never a hard mid-note cut
 *                        (reads as a bug), never a 5s fade with no stinger
 *                        (reads as a website)." What shipped before P10 was a
 *                        0.4s unaligned exponential fade — the second failure,
 *                        exactly. Riser 400ms, ramp 500ms, bed 0.2s behind the
 *                        bar over 900ms.
 *  2. match → armed      the dramatic beat of the game. A CUT UP: the riser
 *                        earns it over 450ms, the match bed is gone in 70ms at
 *                        the downbeat, and the climax bed is at full level on
 *                        that same sample. Not a dissolve — a dissolve says
 *                        "and now, gradually, things are worse". The 70ms cut
 *                        is not negotiable and did not change.
 *  3. armed → match      the arm broken. The one that IS a genuine crossfade:
 *                        1.1s equal-power, and the returning bed opens its
 *                        lowpass 420Hz → open across the same window, so it
 *                        reads as the floor coming back rather than as a loss.
 *  4. → lobby / off      game over, left the room. Clean, 1.0s, no stinger and
 *                        no riser. Nothing happened; something ended.
 *
 * ── AND THEY ARE ALL ABOUT HALF AS LONG AS THEY WERE (§P10 round 2) ────────
 * Owner, on the first build: "takes too long with the crossfades being too
 * slow." Measured worst case from the event to the new bed at level:
 *   lobby→match 5.6s → 2.9s      armed→match 4.4s → 2.1s
 *   match→armed 2.3s → 1.5s      →lobby      4.8s → 2.4s
 * Most of the saving is not the fades: it is not waiting a full 3.636s bar for
 * a grid that is arbitrary anyway (see atDownbeat). The seam measurements were
 * re-run after every one of these changes and are asserted in
 * tools/audiotest.mjs, so "faster" did not buy back the clicks or the dead air.
 */

/** 1. lobby → match. */
function enterMatch() {
  const D = atDownbeat(ctxNow() + 0.5, 1.9);
  riser(D - 0.4, 0.4, 0.16, 5200);
  stingerVi(D);
  // ART §7's exit, to the letter: 800ms ramp to silence with the cutoff closing
  // to 300Hz, starting ON the bar under the stinger. It applies to whichever
  // lobby bed is actually playing — the recorded one, the synthesised one, or
  // both mid-handoff — because each of them has a cutoff of its own.
  for (const v of voices) {
    glide(v.lp.frequency, D, v.lp.frequency.value || 18000, 300, 0.5);
    stopVoice(v, D, 0.5, 'out');
  }
  glide(mix.synthLp.frequency, D, 18000, 300, 0.5);
  fadeParam(mix.synthEnv.gain, D, 0.5, mix.synthEnv.gain.value, 0.0001, 'out');
  busyUntil = D + 0.6;
  // …and the match bed arrives just behind the stinger, so the room is never
  // empty. MEASURED: starting it at D+0.8 (as the ramp to silence finished) left
  // a 0.3s trough at -58 dBFS between the stinger's decay and the bed's
  // fade-in — inside the spec, and audibly a hole. D+0.2 over 0.9s puts the bed
  // at a third of level by the time the brass is gone and fills it, without
  // fighting the stinger for the beat it exists to own.
  //
  // ART §7 specifies "an 800ms exponential ramp to silence" and this ships 500ms
  // against it, with the bed 0.7s behind rather than 2.0s. That is a deliberate
  // departure on the owner's own note ("takes too long with the crossfades being
  // too slow"); the shape the spec is protecting — stinger on the bar, riser
  // into it, a ramp rather than a cut — is intact and measured.
  scheduleBed(D + 0.2, 0.9);
}

/** 2. match → final approach. */
function toFinalApproach() {
  if (mode !== 'match') { applySynthTension(true); return; }
  const key = 'final';
  load(key);
  if (!buffers.has(key)) {
    // The climax bed has not landed (prefetch failed, or the arm came without a
    // two-set warning). Do the gesture anyway with what is here — darken and
    // duck the match bed on the bar — and cut properly the moment the buffer
    // arrives. Never silence: §0.3's fallback rule is the whole reason the
    // synth layer still exists.
    pendingArm = true;
    const D = atDownbeat(ctxNow() + 0.45, 1.0);
    riser(D - 0.45, 0.45, 0.20, 6400);
    for (const v of voices) {
      glide(v.lp.frequency, D, v.lp.frequency.value || 18000, 520, 0.35);
      fadeParam(v.gain.gain, D, 0.35, v.level, v.level * 0.45, 'out');
    }
    glide(mix.synthLp.frequency, D, mix.synthLp.frequency.value, 520, 0.35);
    applySynthTension(true);
    return;
  }
  cutToFinal();
}

function cutToFinal() {
  pendingArm = false;
  const D = atDownbeat(ctxNow() + 0.5, 1.0);
  riser(D - 0.45, 0.45, 0.20, 6400);
  // THE CUT. 70ms is short enough to read as an edit and long enough that the
  // buffer boundary is not a click; the riser's own peak lands on the same
  // sample and covers it.
  for (const v of voices) stopVoice(v, D, 0.07, 'lin');
  fadeParam(mix.synthEnv.gain, D, 0.07, mix.synthEnv.gain.value, 0.0001, 'lin');
  bedWant = 'final';
  startFile('final', D, { fade: 0.04 });
  busyUntil = D + 0.2;
  applySynthTension(true);
}

/** 3. final approach → match (the arm was broken). */
function fromFinalApproach() {
  applySynthTension(false);
  pendingArm = false;
  if (mode !== 'match') return;
  const X = 1.1;
  const D = atDownbeat(ctxNow() + 0.3, 1.0);
  for (const v of voices) stopVoice(v, D, X, 'out');
  bedWant = matchTrack;
  const started = matchTrack && buffers.has(matchTrack)
    // The floor coming back: level AND bandwidth return together, 420Hz → open.
    ? startFile(matchTrack, D, { fade: X, lp: 420, lpTo: 18000, lpDur: X })
    : null;
  if (!started) {
    // No match buffer: the synth bed is the floor, and it comes back the same
    // way — over the same 2.4s, equal-power against the climax fading out, with
    // its own cutoff opening from 420Hz so the gesture survives the fallback.
    synthLive = true;
    ensureSynth();
    glide(mix.synthLp.frequency, D, 420, 18000, X);
    fadeParam(mix.synthEnv.gain, D, X, 0.0001, 1, 'in');
    if (matchTrack) load(matchTrack);
  }
  busyUntil = D + X;
}

/**
 * The synth layer's own answer to §3.10: the match drone's root goes, the fifth
 * (E) stays and becomes the pedal the tension bed's 41.2Hz sub reinforces an
 * octave down, and the filter closes so what is left is darker as well as
 * unresolved.
 *
 * It used to say "runs whether or not a recorded bed is playing — under the
 * climax track it is inaudible", which was an assumption and is now a
 * measurement, and the measurement changed the code rather than the comment: a
 * recorded bed that owns the bed has already retired the drone (raiseBed →
 * silenceSynth → stopDrone), so `drone` is null and this is a no-op. Synth bus
 * soloed under final-approach.opus at full: −180 dBFS. Not "inaudible" — ABSENT.
 * It is the whole gesture when no recording is playing, which is the only time
 * it now runs at all: fallback climax, synth soloed, −37.2 dBFS and 100% of the
 * output.
 */
function applySynthTension(on) {
  if (!g || !drone) return;
  const now = ctxNow();
  const p = drone.rootGain.gain;
  p.cancelScheduledValues(now);
  p.setValueAtTime(Math.max(p.value, EPS), now);
  p.exponentialRampToValueAtTime(on ? EPS : 0.5, now + 1.2);
  glide(drone.lp.frequency, now, drone.lp.frequency.value, on ? 130 : 240, 1.2);
}

/**
 * ART §7's V→i: the dominant on the beat before the bar line, the tonic ON it,
 * two octaves of it. In A minor the V is E, and E is also the pedal the whole
 * §3.10 alarm is built on — so the one stinger the game has is in the key its
 * climax is already in.
 */
function stingerVi(D) {
  if (!g || !mix) return;
  const E3 = A2 * st(7);                // 164.8Hz — the V
  brass(E3, D - BEAT, 0.80, 0.115, mix.fx);
  brass(A2 * 2, D, 1.25, 0.125, mix.fx);        // the i, and it lands
  brass(A2, D, 1.40, 0.095, mix.fx);
  thumpAt(D, 0.11, mix.fx);
}

/**
 * The riser. Filtered white noise sweeping up into the bar line, peaking on it
 * and gone 120ms later — ART §7 asks for 500ms and the arm gets 600ms because
 * it has more to earn. Not pink: a riser has to be BRIGHT to read as tension,
 * and pink is 3dB/octave down exactly where that lives.
 */
function riser(t0, dur, amp, topHz) {
  if (!g || !mix) return;
  const bp = filt('bandpass', 400, 1.4);
  const hp = filt('highpass', 300, 0.7);
  const rg = gain(0);
  const p = panner(0);
  const n = loopNoise('white', t0, dur + 0.2);
  n.connect(hp); hp.connect(bp); bp.connect(rg); rg.connect(p); p.connect(mix.fx);
  glide(bp.frequency, t0, 400, topHz, dur);
  glide(hp.frequency, t0, 300, topHz * 0.45, dur);
  glide(bp.Q, t0, 1.4, 4.0, dur);
  // Linear up to the bar line, then off in 120ms: the peak IS the downbeat.
  rg.gain.setValueAtTime(EPS, t0);
  rg.gain.linearRampToValueAtTime(amp, t0 + dur);
  rg.gain.exponentialRampToValueAtTime(EPS, t0 + dur + 0.12);
  rg.gain.setValueAtTime(0, t0 + dur + 0.14);
  n.onended = () => { try { hp.disconnect(); } catch { /* already gone */ } };
}

/* ── mode changes ───────────────────────────────────────────────────────── */

function start(which) {
  if (!g || !mix || !enabled) return;
  if (mode === which) return;
  const from = mode;
  mode = which;
  rng = makeRng(`chudopoly-music-${which}`);
  if (!sub && !offlineMode) sub = clock.subscribe(pump);
  const now = ctxNow();
  if (from === 'off') {
    bar = 0;
    motif = 0;
    nextBar = now + 0.12;
    nextSwell = now + 6 + rng() * 8;
  }
  rampOut();

  // A ceremony that still holds keeps the room; `mode` is updated above so that
  // resumeBed() raises the right bed when the cue ends, and the buffer for it is
  // warmed now so that handover is instant rather than a second fetch.
  if (ceremonyHolds(which)) {
    if (which !== 'match') { matchTrack = null; tension = false; bedWant = 'lobby'; load('lobby'); }
    return;
  }
  if (ceremony) stopCeremony(now + 0.02, which === 'match' ? 0.45 : 0.9);

  if (which === 'match') {
    matchSeq++;
    if (!matchTrack) matchTrack = pickMatchTrack();
    // A session pays for one lobby + one match + at most one climax, never the
    // set (§0.3 amendment). The lobby loop region is 30.8MB of AudioBuffer and
    // it cannot be heard from inside a game; the synth bed covers the re-decode
    // on the way back, which is the whole reason it is still here.
    release([matchTrack, 'final']);
    if (from === 'menu') { enterMatch(); return; }
    // A cold start straight into a game (reconnect, or a fixture): no lobby bed
    // to leave, so there is nothing for a stinger to be a transition FROM — and
    // nothing to be aligned TO either. MEASURED: waiting for the next downbeat
    // here put 1.9s of silence in front of the bed, which is a bar of the synth
    // transport spent on a grid no listener has heard a single beat of. The menu
    // branch below has always started at once for the same reason.
    stopFiles(now, 0.6, 'out');
    setSynthTrim(now);
    scheduleBed(now + 0.05, 1.2);
    return;
  }

  // → menu. Transition 4: clean, unhurried, no stinger. Nothing happened here;
  // something ended.
  matchTrack = null;
  tension = false;
  release(['lobby', 'victory', 'defeat']);
  const t = Math.max(now + 0.02, busyUntil);
  const X = from === 'off' ? FADE : 1.0;
  stopFiles(t, X, 'out');
  stopDrone(t + X + 0.1);
  bedWant = 'lobby';
  busyUntil = t + X;
  glide(mix.synthLp.frequency, t, mix.synthLp.frequency.value, 18000, 0.4);
  raiseBed(t, X, 'lobby');
}

/**
 * Re-base the synth transport so the incoming bed's first bar lands at `t`.
 *
 * MEASURED: without this, match→lobby left 1.3 SECONDS at −105 dBFS. Bars are
 * 3.636s apart and the transport just keeps counting across a mode change, so
 * the arriving bed waits for the next bar line — up to a full bar after the
 * leaving bed has finished its 1.8s fade. Restarting at 0 is also the musically
 * right answer for the menu: the progression is eight bars long and it should
 * begin on Am, not two thirds of the way through the second sentence.
 */
function rebase(t) {
  nextBar = t + 0.05;
  bar = 0;
  motif = 0;
  nextSwell = t + 5 + rng() * 8;
}

/** The synth bed's per-mode trim. Ramped rather than set so a mode change that
 *  lands while the bed is audible is not a step. */
function setSynthTrim(t) {
  const p = mix.synth.gain;
  cancelFrom(p, t);
  p.setValueAtTime(Math.max(p.value, EPS), t);
  p.linearRampToValueAtTime(synthTrim(), t + 0.25);
}

/**
 * Which of the two match beds this match gets. Seeded from the per-match key so
 * every client in the room hears the same one and nobody's client can drift
 * onto the other track halfway through; with no key it is still deterministic
 * rather than random, because a bed that differs per reload is a bug report
 * nobody can reproduce.
 */
function pickMatchTrack() {
  const r = makeRng(`chudopoly-bed-${matchKey}`);
  r(); r();
  // NO IMMEDIATE REPEAT. The picker is a fair coin and was verified as one (48%
  // over 400 room codes), and a fair coin over two beds still plays the same one
  // twice running half the time — which is exactly the complaint. Excluding the
  // last one leaves three equally likely, so back-to-back repeats are not
  // unlikely, they are impossible.
  //
  // SCOPE: module-level, so it spans consecutive games in one sitting and not a
  // page reload. That is the whole of the complaint — a repeat after you have
  // closed the tab and come back is not "there is only one track" — and the
  // alternative costs a storage key and a migration for a case nobody reported.
  //
  // It is CLIENT-LOCAL, which means two players in one room can end up on
  // different beds. That is already true (matchKey folds in a per-tab count, so
  // a player who joined late keys differently) and it is invisible: the bed is
  // per-listener ambience, no rule reads it, and neither player can hear the
  // other's. Not repeating yourself is worth more than agreeing with someone you
  // cannot hear.
  const pool = MATCH_TRACKS.filter((k) => k !== lastBed);
  const pick = pool[Math.floor(r() * pool.length) % pool.length];
  lastBed = pick;
  return pick;
}

/**
 * Put the right bed on at `D`.
 *
 * ── THE SYNTH LAYER IS A GAP-FILLER, NOT AN UNDERLAY (§P10 round 3) ────────
 * Owner: "when switching to the game and also on the main menu I think the
 * synthesized music tracks are still audible slightly". They were, and not
 * because anything leaked: this function used to raise the synth bed
 * UNCONDITIONALLY and only then ask handoff() to cross to the recording, so the
 * synthesised bed played a full phrase on every entrance whether or not the
 * file was already sitting in memory.
 *
 * MEASURED on an offline transition render with every buffer resident — i.e.
 * with no gap to cover at all: entering a match started the recorded bed at
 * 3.806s and did not finish crossing to it until 5.206s; the menu was 1.888s +
 * a 1.4s crossfade. Five seconds of a bed whose whole documented job is to
 * cover "0.4-2.0s before a file has been fetched and decoded". At the levels
 * this round shipped, that is simply audible, which is what the owner heard.
 *
 * So the question is asked first: if the recording is here, it IS the bed and
 * the synth never sounds. If it is not, the synth starts instantly and
 * handoff() crosses to the file the moment it lands — the amendment's "no dead
 * air, no spinner" — and that path is unchanged and still measured.
 */
function scheduleBed(D, fadeIn) {
  raiseBed(D, fadeIn, tension ? 'final' : matchTrack);
}

function raiseBed(D, fadeIn, key) {
  bedWant = key;
  rebase(D);
  if (key && buffers.has(key) && startFile(key, D, { fade: fadeIn })) {
    silenceSynth(D);
    synthUpAt = 0;
    return;
  }
  // The recording is not here yet, so the synth has a gap to cover — but hold it
  // back by SYNTH_GRACE before it becomes audible, UNLESS the fetch has already
  // failed, in which case there is nothing to wait for and waiting is just
  // silence. `failed` is set by load()'s catch, which a real offline browser
  // reaches in milliseconds.
  const S = failed.has(key) ? D : D + SYNTH_GRACE;
  synthLive = true;
  synthOffAt = 0;
  synthUpAt = S;
  ensureSynth();
  setSynthTrim(S);
  glide(mix.synthLp.frequency, S, mix.synthLp.frequency.value, 18000, 0.3);
  fadeParam(mix.synthEnv.gain, S, fadeIn, 0.0001, 1, 'in');
  handoff(D);
}

/**
 * Take the synth layer out of the room at `at`. Not "turn it down": the
 * envelope goes to its floor, the scheduler stops building bars, and the drone
 * is retired, so the bus has no nodes on it at all.
 *
 * MEASURED after this, synth bus soloed through the real chain while each
 * recorded bed is at full: −180 dBFS in every case — digital zero, not a small
 * number. There is no EPS residue to be revealed by a louder mix later, because
 * there is no signal.
 */
function silenceSynth(at) {
  synthLive = false;
  synthOffAt = 0;
  if (!mix) return;
  fadeParam(mix.synthEnv.gain, at, 0.08, mix.synthEnv.gain.value, 0.0001, 'out');
  stopDrone(at + 0.12);
}

/** Bring the synth layer up as the bed, whatever mode we are in. */
function ensureSynth() {
  if (mode === 'match') startDrone();
  if (mode !== 'match' && drone) stopDrone(ctxNow() + 0.6);
}

/* ── THE CEREMONY ────────────────────────────────────────────────────────
 *
 * The endgame pair is not a bed and must not be driven by `mode`. Owner: "let
 * it play/finish for the winners even when rematching or going back to main
 * menu." So it is a ONE-SHOT THAT OWNS THE MUSIC BUS, and the mode machine
 * defers to it rather than the other way round.
 *
 * THE SUPERSEDE RULE, stated once. A ceremony yields to exactly two things:
 *   • a match actually starting — the match bed cannot be muted because someone
 *     is still enjoying their lap of honour, and by then they have chosen to
 *     play again
 *   • a newer ending (see below)
 * and to nothing else. Every menu-side move — win overlay → Rematch → lobby →
 * main menu → lobby — leaves it alone, which is the entire request. `holds`
 * narrows that per track: 'menu' for victory, 'none' for defeat, so defeat ends
 * when the player leaves the overlay and victory does not.
 *
 * A SECOND ENDING while one is playing is reachable (a fast rematch against
 * bots) and it RESTARTS. A new win is a new ceremony; hearing the previous
 * game's fanfare tail under a fresh overlay would read as a stuck sound. The
 * outgoing instance gets 0.25s of equal-power fade so the retrigger is an edit
 * rather than a click.
 *
 * MUTING mid-cue stops it and clears it, so un-muting raises the bed the screen
 * calls for and does NOT restart the cue from the top — un-muting into the first
 * five seconds of a victory swell you already heard would be worse than silence.
 */
function ceremonyHolds(nextMode) {
  if (!ceremony) return false;
  if (nextMode === 'match') return false;
  return ceremony.spec.holds === 'menu';
}

export function ending(kind) {
  const key = kind === 'victory' ? 'victory' : 'defeat';
  if (!g || !mix || !enabled || !TRACKS[key]) return;
  if (buffers.has(key)) { startCeremony(key); return; }
  const seq = matchSeq;
  load(key).then((buf) => {
    // The game has to still be the one that ended by the time this lands: a
    // fetch resolving after the player has started ANOTHER match must not
    // interrupt it. Generation, not mode — see matchSeq.
    if (buf && matchSeq === seq && enabled && g) startCeremony(key);
  });
}

function startCeremony(key) {
  const spec = TRACKS[key];
  const buf = buffers.get(key);
  if (!spec || !buf || !g || !mix) return;
  const t = ctxNow() + 0.02;
  if (ceremony) stopCeremony(t, 0.25);
  // The bed gets out of the way. Not a crossfade — the sting is landing on this
  // same instant and the room should be the cue's.
  stopFiles(t, 0.6, 'out');
  silenceSynth(t);
  busyUntil = t;
  const src = g.ctx.createBufferSource();
  nodesMade++;
  src.buffer = buf;
  const vg = g.ctx.createGain();
  nodesMade++;
  vg.gain.value = dbToGain(spec.trimDb);
  src.connect(vg); vg.connect(mix.file);
  src.start(t);
  const c = { key, spec, src, gain: vg, startAt: t, endAt: t + buf.duration };
  // Both cues end in digital silence measured (see TRACKS), so this is the real
  // end of the piece and not a cut.
  src.onended = () => { if (ceremony === c) resumeBed(); };
  ceremony = c;
  note(`startCeremony ${key} at ${t.toFixed(3)} level ${vg.gain.value.toFixed(4)} dur ${buf.duration.toFixed(2)}`);
}

function stopCeremony(at, dur) {
  const c = ceremony;
  ceremony = null;
  if (!c || !g) return;
  const t = Math.max(at, ctxNow());
  note(`stopCeremony ${c.key} at ${t.toFixed(3)} over ${dur}`);
  fadeParam(c.gain.gain, t, dur, dbToGain(c.spec.trimDb), 0.0001, 'out');
  try { c.src.onended = null; c.src.stop(t + dur + 0.03); } catch { /* already stopped */ }
}

/** The ceremony is over. Hand the room back to whatever the screen now wants,
 *  at that screen's own level, unhurried — nothing happened, something ended. */
function resumeBed() {
  note('ceremonyEnded');
  ceremony = null;
  if (!g || !mix || mode === 'off' || !enabled) return;
  const t = ctxNow() + 0.02;
  setSynthTrim(t);
  raiseBed(t, 1.6, mode === 'match' ? matchTrack : 'lobby');
}

/**
 * Cross from the synth bed to the recorded one as soon as the buffer exists.
 * A plain equal-power crossfade on the transport's bar, over 3.0s: the two are
 * the same music in the same key, so this is the one place a dissolve is the
 * honest answer. It is not one of the four TRANSITIONS — it is a load event,
 * and the player should not be able to name the moment it happened.
 */
function handoff(notBefore) {
  const key = bedWant;
  if (!key || !TRACKS[key]) return;
  // Synchronous when the buffer is already here — a microtask hop would be
  // invisible live and is the difference between measuring a transition and
  // measuring the first sample of one in offlineTransition().
  if (buffers.has(key)) { crossToFile(key, notBefore); return; }
  load(key).then((buf) => { if (buf) crossToFile(key, notBefore); });
}

function crossToFile(key, notBefore) {
  if (!g || !mix) return;
  if (bedWant !== key || mode === 'off' || !enabled) return;
  const lead = leadVoice();
  if (lead && lead.key === key) return;
  // Has the fallback actually been HEARD yet? If the buffer landed inside its
  // grace there is nothing to cross FROM and nothing to align TO — no music is
  // sounding — so the recording is simply the bed, from the moment the bed was
  // due. Waiting for a bar here is what put 3.3s of synthesised menu music in
  // front of a file that had been ready since 176ms.
  const early = synthUpAt > 0 && ctxNow() < synthUpAt;
  const X = early ? 0.5 : 1.4;
  const D = early ? Math.max(ctxNow() + 0.05, notBefore)
    : atDownbeat(Math.max(ctxNow() + 0.3, notBefore), 1.9);
  const v = startFile(key, D, { fade: X });
  if (!v) return;
  for (const other of voices) if (other !== v) stopVoice(other, D, X, 'out');
  if (early) { silenceSynth(D); synthUpAt = 0; return; }
  // …and the SYNTH steps down, over the complementary curve. It keeps
  // scheduling bars until the crossfade is over so a source that fails to
  // start cannot leave a hole.
  fadeParam(mix.synthEnv.gain, D, X, mix.synthEnv.gain.value, 0.0001, 'out');
  synthOffAt = D + X;
  synthUpAt = 0;
  stopDrone(D + X + 0.2);
}

function stopAll(fade) {
  const wasMode = mode;
  // Cleared, not paused: un-muting raises the bed the screen calls for rather
  // than restarting a 40s cue from the top.
  stopCeremony(ctxNow() + 0.01, Math.max(fade * 0.5, 0.15));
  mode = 'off';
  tension = false;
  bedWant = null;
  pendingArm = false;
  synthLive = true;
  synthOffAt = 0;
  synthUpAt = 0;
  busyUntil = 0;
  if (!g || !mix) { drone = null; voices = []; return; }
  mix.synthEnv.gain.cancelScheduledValues(0);
  mix.synthEnv.gain.value = 1;
  mix.synthLp.frequency.cancelScheduledValues(0);
  mix.synthLp.frequency.value = 18000;
  const now = ctxNow();
  const p = mix.master.gain;
  p.cancelScheduledValues(now);
  p.setValueAtTime(Math.max(p.value, EPS), now);
  p.exponentialRampToValueAtTime(0.0001, now + Math.max(fade, 0.05));
  stopFiles(now, Math.max(fade, 0.05), 'out');
  stopDrone(now + Math.max(fade, 0.05) + 0.1, true);
  voices = [];
  if (wasMode !== 'off' && sub) { sub(); sub = null; }
}

/**
 * The lookahead scheduler. Runs on core/clock.js rather than setInterval (§0.6,
 * one clock), so it stops with the rest of the client when the tab is hidden
 * and cannot dump a backlog of bars on return — `nextBar` is snapped forward
 * instead of caught up.
 */
function pump() {
  if (!g || mode === 'off') return;
  const t0 = performance.now();
  const now = ctxNow();
  if (nextBar < now - 1) { nextBar = now + 0.05; bar = 0; }   // returned from hidden
  if (synthOffAt && now > synthOffAt) { synthLive = false; synthOffAt = 0; }
  if (drone && drone.stopAt != null && now > drone.stopAt) drone = null;
  let guard = 0;
  while (nextBar < now + LOOKAHEAD && guard++ < 4) {
    // The synth transport keeps counting bars even while a recorded bed is the
    // thing you hear: it is the grid the stinger and the riser land on when the
    // recorded bed has none of its own (see atDownbeat), and it is what the
    // fallback resumes onto if a source dies.
    if (synthLive) {
      if (mode === 'menu') scheduleMenuBar(nextBar, bar);
      else if (mode === 'match') scheduleMatchBar(nextBar, bar);
    }
    nextBar += BAR;
    bar++;
  }
  if (synthLive && nextSwell && now + LOOKAHEAD > nextSwell) {
    hangarSwell(nextSwell);
    nextSwell += (mode === 'menu' ? 14 : 15) + rng() * 8;
  }
  reloop(now);
  if (pendingArm && buffers.has('final')) cutToFinal();
  /* ── THE BED RAN OUT ENTIRELY (owner: "music will stop during gameplay all
   * together and just won't play at all") ──────────────────────────────────
   * A hidden/minimized tab parks rAF, so this pump stops while the audio
   * thread plays the current pass to its end; past ~29–64s away the pass runs
   * out, its onended fires (it does fire hidden — measured live), and the
   * voice is dead before the first pump after return. reloop() starts from
   * leadVoice(), which skips dead voices, so its guard returned forever:
   * MEASURED (headless Chromium, clock stopped 33s over match4's 29.09s pass)
   * mode 'match', bedWant set, buffer resident, fileVoices 0, master RMS 0.0,
   * permanently. So the no-bed state is detected here and the bed re-raised.
   * raiseBed() covers both halves itself: buffer resident → the file starts;
   * evicted or never landed → the synth covers and handoff() re-fetches.
   * `ceremony` silences the bed on purpose and resumes it itself; a synth
   * that is up or still fading (synthOffAt) means music IS playing. */
  if (!ceremony && bedWant && !synthLive && !synthOffAt && !leadVoice()) {
    raiseBed(now + 0.02, 0.35, bedWant);
  }
  for (let i = voices.length - 1; i >= 0; i--) {
    if (voices[i].dead || voices[i].endAt < now - 0.2) voices.splice(i, 1);
  }
  pumps++;
  pumpMs += performance.now() - t0;
}

/* ── voices ─────────────────────────────────────────────────────────────── */

function gain(v) { nodesMade++; const n = g.ctx.createGain(); n.gain.value = v; return n; }

function panner(v) {
  nodesMade++;
  const p = g.ctx.createStereoPanner();
  p.pan.value = v;
  return p;
}

function osc(type, hz, t0, tEnd) {
  nodesMade++;
  const o = g.ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(hz, 0.01), t0);
  o.start(t0);
  if (tEnd) o.stop(tEnd);
  return o;
}

function filt(type, hz, q = 1) {
  nodesMade++;
  const f = g.ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = Math.max(10, hz);
  f.Q.value = q;
  return f;
}

function noiseSrc(kind, t0, dur, rate = 1) {
  nodesMade++;
  const s = g.ctx.createBufferSource();
  const buf = g.noise[kind] || g.noise.pink;
  s.buffer = buf;
  s.playbackRate.value = rate;
  const maxOff = Math.max(0, buf.duration - dur * rate - 0.01);
  s.start(t0, rng() * maxOff, dur * rate + 0.01);
  s.stop(t0 + dur + 0.02);
  return s;
}

/** The noise buffers are 1.2s and a bar is 3.636s, so anything that has to run
 *  longer than one buffer loops it. Uncorrelated with the bar by construction:
 *  1.2 does not divide 3.636. */
function loopNoise(kind, t0, dur) {
  nodesMade++;
  const s = g.ctx.createBufferSource();
  s.buffer = g.noise[kind] || g.noise.white;
  s.loop = true;
  s.start(t0);
  s.stop(t0 + dur);
  return s;
}

/* ── THE MENU BED ────────────────────────────────────────────────────────
 *
 * Five layers, one bar at a time. It has a PULSE — that is the difference
 * between "sit down at a table" and ambient wallpaper, and it is the whole
 * brief. The pulse is brushed noise on 2 and 4, which is the card_slide voice
 * with a shorter envelope, so the menu and the game are the same instrument.
 */
function scheduleMenuBar(t, index) {
  const chord = PROGRESSION[index % PROGRESSION.length];
  const root = A2 * st(chord[0]);

  /* 1. pad — open fifth, no third. Two detuned saws and a sub sine.
   *
   * ── THE PAD IS IN STEREO NOW (§P10 fix 2) ─────────────────────────────
   * MEASURED before this: ONE StereoPanner in the whole module, inside a swell
   * that fires every 14–22 seconds. Everything else summed to the centre, so a
   * score built out of two saws detuned against each other was throwing away
   * the only thing that detuning is FOR. The pair now sits at ±0.5, which is
   * where the beating between them becomes width instead of wobble. */
  const padLp = filt('lowpass', 620, 0.9);
  const padEnv = gain(0);
  padLp.connect(padEnv); padEnv.connect(mix.synth);
  // A slow open/close across the bar: the pad breathes rather than sits.
  padLp.frequency.setValueAtTime(520, t);
  padLp.frequency.exponentialRampToValueAtTime(900, t + BAR * 0.45);
  padLp.frequency.exponentialRampToValueAtTime(480, t + BAR);
  for (const [mult, amp, det, pan] of [
    [1, 0.3, 1, -0.5],
    [1, 0.24, 1.006, 0.5],
    [st(chord[2]), 0.2, 0.997, 0.28],
    [0.5, 0.26, 1, 0],
  ]) {
    const vg = gain(amp);
    const ov = osc(mult === 0.5 ? 'sine' : 'sawtooth', root * mult * det, t, t + BAR + 0.9);
    if (pan) { const p = panner(pan); ov.connect(p); p.connect(vg); } else ov.connect(vg);
    vg.connect(padLp);
  }
  /* The pad SUSTAINS ACROSS THE BAR LINE. It used to be attack 0.55 / hold
     1.45 / release 2.00 = 4.00s against a 3.64s bar, which sounds like an
     overlap and is not one: the release is exponential to EPS, so the old bar
     was already at nothing by ~3.4s and the new bar spent its first 0.55s
     climbing. The measured consequence was a HOLE at every bar line — 12 of the
     60 seconds of the render sat at RMS −50 to −64 dB, which is not a rest, it
     is the music stopping four times a phrase.

     ── IT WAS STILL HAPPENING (§P10) ───────────────────────────────
     The retune above moved the hole; it did not close it. Attack 0.30 / hold
     2.62 / release 1.53 starts the release at 2.92s of a 3.64s bar, and an
     exponential release to EPS is DOWN 51dB by the time the next bar's attack
     completes — so the arithmetic "4.45s of envelope against a 3.64s bar" was
     never the question. MEASURED on a 30s render, 100ms RMS: a 0.8s trough
     bottoming at −59 dBFS against a −24 dBFS bed, once every 3.7s, i.e. once a
     bar, forever. p5 of the whole envelope was −51.1 dB.

     Hold 0.86 of a bar / release 0.62 of a bar puts the release START at 3.13s
     and leaves the pad at −8.5dB when the NEXT bar's attack begins and −20dB
     when it completes — so the two bars genuinely overlap and the worst point of
     the crossing is a ~6dB dip rather than a 34dB hole. */
  swell(padEnv.gain, t, 0.19, 0.30, BAR * 0.86, BAR * 0.62);

  /* 1b. SHEEN — the pad's presence band (§P10 fix 3).
   *
   * MEASURED on the old 45s menu render: 0.24% of the bed's energy above
   * 2.5kHz, and the pad — four fifths of the level — was capped at 900Hz by its
   * own lowpass sweep. music.js:555 already ran this exact diagnosis on the
   * MATCH bed ("audible on the analyser and inaudible in the room") and fixed
   * it with a presence band; the diagnosis was never run on the menu.
   *
   * Two saws two octaves up through a 3.2kHz bandpass, panned against each
   * other. It carries no new harmony — it is the pad's own fifth — and it is
   * what a laptop speaker actually reproduces of a chord whose fundamental is
   * 110Hz. */
  const sheenBp = filt('bandpass', 3200, 0.7);
  const sheenEnv = gain(0);
  sheenBp.connect(sheenEnv); sheenEnv.connect(mix.synth);
  for (const [mult, amp, pan] of [[4, 0.05, 0.42], [4 * st(chord[2]), 0.035, -0.42]]) {
    const vg = gain(amp);
    const ov = osc('sawtooth', root * mult, t, t + BAR + 0.9);
    const p = panner(pan);
    ov.connect(p); p.connect(vg); vg.connect(sheenBp);
  }
  swell(sheenEnv.gain, t, 0.5, 0.55, BAR * 0.45, BAR * 0.5);

  /* 2. bugle — bars 0 and 2 of the phrase only. Sparse by construction: never
        more than 3 notes in 7.3s, so it reads as a call, not a tune. */
  if (index % 2 === 0) {
    if (index % 4 === 0) motif = (motif + 1 + Math.floor(rng() * (MOTIFS.length - 1))) % MOTIFS.length;
    const shape = MOTIFS[motif];
    for (const [deg, at] of shape) {
      const hz = root * st(degreeSemis(deg)) * 2;      // an octave up: a bugle
      brass(hz, t + at * BEAT, 0.85, 0.085);
    }
  }

  /* 3. backbeat — a brushed tick on 2 and 4, a soft floor thump on 1. */
  for (const b of [1, 3]) brush(t + b * BEAT, b === 3 ? 0.055 : 0.07, b === 3 ? 0.22 : -0.22);
  thumpAt(t, 0.075);
  if (index % 4 === 3) thumpAt(t + BEAT * 3.5, 0.05);    // a turnaround pickup

  /* 4. AIR (§P10 fix 4). */
  air(t, index);
}

/**
 * ART §7 layer 4, built at last: "filtered white noise, highpass ~4kHz, gated
 * 8ths at −26dB."
 *
 * What shipped under the name `air()` for the whole of P5–P9 was a 380–900Hz
 * bandpassed PINK swell every 14–22 seconds — not white, not highpassed, an
 * octave and a half below the specified corner, and not gated. It was a good
 * texture and it is still here, renamed hangarSwell(); this is the layer the
 * spec actually asked for, and it is the reason the menu bed now has anything
 * at all above 4kHz.
 *
 * −26dB is relative to the bed, and it is measured rather than asserted: at
 * AIR_AMP the 45s menu render puts the >4kHz band 25.8dB under the bed's
 * broadband RMS. The 8ths alternate strong/weak so the gate reads as a pulse
 * and not as a tremolo, and they are swung 4% late on the offbeats for the same
 * reason the card sounds jitter — a machine-exact 8th is a machine.
 *
 * ANTI-FATIGUE (ART §7): "every 2 loops change exactly one thing (mute the air
 * 4 bars)". The progression is 8 bars, so 2 loops is 16; the air drops out for
 * the last 4 bars of every second loop, i.e. 4 bars in 16.
 */
const AIR_AMP = 0.075;
const AIR_HP = 4000;

function air(t, index) {
  if (index % 16 >= 12) return;                  // the 4 bars off — see above
  const hp = filt('highpass', AIR_HP, 0.7);
  const hp2 = filt('highpass', AIR_HP, 0.7);     // 12dB/oct: 4kHz means 4kHz
  const ag = gain(0);
  const p = panner(index % 2 ? 0.2 : -0.2);
  const n = loopNoise('white', t, BAR + 0.12);
  n.connect(hp); hp.connect(hp2); hp2.connect(ag); ag.connect(p); p.connect(mix.synth);
  for (let e = 0; e < 8; e++) {
    const swing = e % 2 ? 0.04 * (BEAT / 2) : 0;
    const at = t + e * (BEAT / 2) + swing;
    perc(ag.gain, at, AIR_AMP * (e % 2 ? 0.55 : 1), 0.006, BEAT * 0.19);
  }
  n.onended = () => { try { hp.disconnect(); } catch { /* already gone */ } };
}

/** Degree index (may be negative) → semitones, wrapping the A-minor scale. */
function degreeSemis(deg) {
  const n = MINOR.length;
  const oct = Math.floor(deg / n);
  const i = ((deg % n) + n) % n;
  return MINOR[i] + oct * 12;
}

/**
 * Brass without samples: a sawtooth stack under a lowpass that OPENS on the
 * attack and closes through the note. Same construction as BANK.fanfare — the
 * menu and the victory are deliberately the same instrument, so the fanfare
 * sounds like the theme paying off rather than like a different game.
 */
function brass(hz, t, dur, amp, dest) {
  const lp = filt('lowpass', 420, 1.1);
  const env = gain(0);
  lp.connect(env); env.connect(dest || mix.synth);
  lp.frequency.setValueAtTime(420, t);
  lp.frequency.exponentialRampToValueAtTime(2400, t + 0.07);
  lp.frequency.exponentialRampToValueAtTime(700, t + dur);
  for (const [mult, a, det] of [[1, 0.34, 1], [1, 0.22, 1.005], [2, 0.08, 1]]) {
    const vg = gain(a);
    const ov = osc('sawtooth', hz * mult * det, t, t + dur + 0.06);
    ov.connect(vg); vg.connect(lp);
  }
  swell(env.gain, t, amp, 0.035, dur * 0.35, dur * 0.6);
}

/** The backbeat: card_slide's noise burst with a 40ms envelope on it. */
function brush(t, amp, pan) {
  const bg = gain(0);
  const bp = filt('bandpass', 2600, 1.6);
  const hp = filt('highpass', 900, 0.7);
  const n = noiseSrc('pink', t, 0.075, 1.15);
  const p = panner(pan || 0);
  n.connect(hp); hp.connect(bp); bp.connect(bg); bg.connect(p); p.connect(mix.synth);
  glide(bp.frequency, t, 2100, 3600, 0.05);
  perc(bg.gain, t, amp, 0.006, 0.055);
  n.onended = () => { try { hp.disconnect(); } catch { /* already gone */ } };
}

function thumpAt(t, amp, dest) {
  const tg = gain(0);
  const o = osc('sine', 74, t, t + 0.22);
  glide(o.frequency, t, 74, 44, 0.13);
  o.connect(tg); tg.connect(dest || mix.synth);
  perc(tg.gain, t, amp, 0.008, 0.17);
}

/* ── THE MATCH BED ───────────────────────────────────────────────────────
 *
 * A drone and nothing else: A1 + E2 + a brown floor, one filter drifting on a
 * 22s LFO, plus a hangar-air swell every 15–23s.
 *
 * THE FATIGUE ARGUMENT, since a bed that grates by turn 10 is worse than
 * silence. It has no rhythm, no melody and no loop — there is no repeating
 * figure for attention to latch onto, and the only motion is a filter LFO whose
 * period (22s) is prime against the air swell's (15–23s), so the texture never
 * lands in the same place twice. It is also 22dB under the quietest STING and
 * ducks another 5–9dB under every one of them (dip()).
 *
 * Measured justification for having it at all: a full seeded 3-player game
 * (scratchpad r6, real bot pacing) spends 89.9s of its 150s wall clock with NO
 * sfx onset inside 1.5s — 60% of the game is silence. That is the "under-fed"
 * complaint, and it is what this occupies. In the bot-storm case (400ms
 * cadence, scratchpad r9-400) there is not one gap over 1.5s in 79.5s, and
 * there the bed is ducked essentially continuously, which is correct.
 */
function startDrone() {
  // A drone with a stopAt is on its way out and its oscillators are already
  // scheduled to stop; reusing it would give the returning bed a voice that
  // dies under it. Let go of it and build a fresh one.
  if (drone && drone.stopAt == null) return;
  drone = null;
  const now = ctxNow();
  const lp = filt('lowpass', 240, 1.1);
  const dg = gain(0);
  lp.connect(dg); dg.connect(mix.synth);

  // 22s drift on the cutoff. An oscillator into an AudioParam costs nothing per
  // frame — this is why there is no JS running for the match bed at all.
  const lfo = osc('sine', 1 / 22, now, 0);
  const lfoAmt = gain(70);
  lfo.connect(lfoAmt); lfoAmt.connect(lp.frequency);

  const rootGain = gain(0.5);
  const rv = osc('sine', A2 / 2, now, 0);                 // A1, 55Hz
  const rv2 = osc('triangle', A2 / 2 * 1.004, now, 0);
  const rg2 = gain(0.25);
  rv.connect(rootGain); rv2.connect(rg2); rg2.connect(rootGain);
  rootGain.connect(lp);

  // E2 (82.4Hz) — the fifth, an octave above the 41.2Hz sub the §3.10 tension
  // bed runs, which is what lets the alarm land IN the harmony (see the header).
  const fifth = gain(0.34);
  const fv = osc('triangle', E2_HZ, now, 0);
  fv.connect(fifth); fifth.connect(lp);

  const floorG = gain(0.5);
  const fn = g.ctx.createBufferSource();
  nodesMade++;
  fn.buffer = g.noise.brown;
  fn.loop = true;
  fn.connect(floorG); floorG.connect(lp);
  fn.start(now);

  /* ── THE PRESENCE BAND (§P9 FEEL round 3) ────────────────────────────────
   *
   * MEASURED: -38.3 dBFS RMS, envelope sd 2.3dB over 45s, 11.4dB under the menu
   * bed, and a 4-bar phrase that autocorrelates at r=0.72 — "shape without
   * presence: it just cannot be heard".
   *
   * The level is not the reason, and raising it is not available: the bed's
   * whole contract is that it sits under card_slide and tools/audiotest.mjs
   * asserts exactly that (-26.7 vs -24.8 dBFS, i.e. 1.9dB of room). The reason
   * is the SPECTRUM. Every voice in this bed is under a 240Hz lowpass — 55Hz
   * root, 82Hz fifth, brown floor — and a laptop or phone speaker reproduces
   * essentially nothing there. The bed was audible on the analyser and inaudible
   * in the room.
   *
   * So it gets a band where small speakers actually live: pink noise through a
   * bandpass at a twentieth of the floor's gain. It carries no new information
   * and adds ~0.4dB of broadband level (it is one narrow band of an
   * already-quiet noise source), but it puts the bed's breathing where it can be
   * heard, and it rides the SAME `dg` envelope, so the 4-bar phrase moves with
   * it instead of staying under the woofer.
   *
   * §P10 fix 2: it is now TWO bandpasses at 590 and 650Hz panned ∓0.45 off the
   * same source. Two different filters on one noise source decorrelate below
   * their own bandwidth, which is what makes this width rather than a mono
   * signal with a pan control on it.
   *
   * Deliberately NOT a tone: a pitched voice at 620Hz would be a melody the bed
   * has spent 150 seconds not having (see THE FATIGUE ARGUMENT above).
   */
  const airG = gain(AIR_PHRASE[0]);
  const an = g.ctx.createBufferSource();
  nodesMade++;
  an.buffer = g.noise.pink;
  an.loop = true;
  for (const [hz, pan] of [[590, -0.45], [650, 0.45]]) {
    const bp = filt('bandpass', hz, 0.42);
    const p = panner(pan);
    an.connect(bp); bp.connect(p); p.connect(airG);
  }
  airG.connect(dg);
  an.start(now);

  // Held, not enveloped: a 2.2s fade-in and then nothing scheduled at all, so
  // there is no automation event queued for the rest of the game.
  // 0.045, not 0.5: at 0.5 the offline render measured the bed at -8.9 dBFS
  // peak / -17.7 RMS, i.e. LOUDER than half the sting bank. -21dB puts it at
  // -30.6 peak / -39.2 RMS — under card_slide, the quietest routine sound.
  dg.gain.setValueAtTime(EPS, now);
  dg.gain.linearRampToValueAtTime(DRONE_GAIN, now + 2.2);
  drone = { lp, dg, air: airG, rootGain, fifth: fv, nodes: [rv, rv2, fv, fn, an, lfo] };
  note(`startDrone at ${now.toFixed(3)}`);
  if (tension) applySynthTension(true);
}

/**
 * One bar of the match bed: the pulse, and the bar's share of the four-bar
 * breath. There is still no per-frame JS here — this is the same lookahead
 * scheduler the menu uses, it builds two small nodes a bar, and the drone's own
 * voices remain persistent oscillators with automation written onto them rather
 * than anything rebuilt.
 *
 * The breath is deliberately asymmetric: bars 1 and 2 rise, bar 3 is the top
 * (and the only bar the fifth leaves the tonic chord for the VI), bar 4 comes
 * back down BELOW the starting level before the next phrase lifts again. A
 * cycle that returns exactly to where it began is a loop; one that undershoots
 * and re-attacks is a phrase.
 */
function scheduleMatchBar(t, index) {
  if (!drone || (drone.stopAt != null && t >= drone.stopAt)) return;
  for (const [b, amp] of MATCH_PULSE) pulse(t + b * BEAT, amp);

  // §P9 FEEL round 3: the breath measured 2.3dB of envelope sd over 45s, which
  // is a phrase you can autocorrelate and not one you can hear. The trough is
  // deepened rather than the crest raised — the crest is what audiotest holds
  // against card_slide, and there is 1.9dB of room there and none to spare.
  // 1.26 → 0.52 is 7.7dB of travel a bar, against the old 2.3.
  const phase = index % MATCH_PHRASE;
  const to = phase === 1 ? DRONE_GAIN * 1.26
    : phase === 2 ? DRONE_GAIN * 1.10
      : phase === 3 ? DRONE_GAIN * 0.52
        : DRONE_GAIN * 0.86;
  try { drone.dg.gain.linearRampToValueAtTime(to, t + BAR); } catch { /* stopped */ }
  // …and the presence band swings four times as far, in the band that carries.
  if (drone.air) {
    try {
      drone.air.gain.linearRampToValueAtTime(AIR_PHRASE[phase], t + BAR * 0.9);
    } catch { /* stopped */ }
  }

  // §3.10: while the final approach is armed the fifth IS the pedal the tension
  // bed's 41.2Hz sub reinforces, and a pedal that wanders is not a pedal.
  if (tension) return;
  const up = phase === 2;
  try {
    drone.fifth.frequency.linearRampToValueAtTime(up ? F2_HZ : E2_HZ, t + BAR * 0.6);
  } catch { /* stopped */ }
}

/** The pulse voice. Not a kick (§7 forbids one): a swelled 68→40Hz sine under a
 *  150Hz lowpass, with a 50ms attack rather than a transient, so it arrives as
 *  something turning over below the floor rather than as a drum being hit. */
function pulse(t, amp) {
  const lp = filt('lowpass', 150, 0.7);
  const pg = gain(0);
  lp.connect(pg); pg.connect(mix.synth);
  const o = osc('sine', 68, t, t + 0.95);
  glide(o.frequency, t, 68, 40, 0.30);
  o.connect(lp);
  // Long rather than loud. The bed's peak is capped by tools/audiotest.mjs
  // (it must stay under card_slide), so the stroke buys its presence in
  // DURATION — 0.84s of swell against a 1.82s grid is a 46% duty cycle, which
  // is what puts a measurable modulation on the envelope at a peak that does
  // not move.
  swell(pg.gain, t, amp, 0.07, 0.22, 0.55);
}

/**
 * Retire the drone AT `at`, not now.
 *
 * ── MEASURED BUG, §P10 ─────────────────────────────────────────────────────
 * The previous version did `cancelScheduledValues(now)` and then wrote the
 * fade from `now`, which is two mistakes on one line when `at` is in the
 * future — and it always is, because every caller schedules it behind a
 * crossfade. cancelScheduledValues(now) deletes the 2.2s fade-in and every bar
 * ramp the phrase had written, and the gain then teleports to whatever the last
 * setValueAtTime left it at, which is EPS. It also nulled `drone` immediately,
 * so scheduleMatchBar's `if (!drone) return` silenced the pulse from the same
 * instant.
 *
 * The consequence in the shipped game: the moment the recorded match bed's
 * buffer finished decoding, the synthesised bed under it was pinned at −100dB
 * for the whole 3-second handoff crossfade — a hole exactly where the load
 * policy promised there would not be one. A 24s offline transition render of
 * `[{at:0,do:'match'}]` measured the first six seconds at −114 dBFS, i.e.
 * digital silence, which is how this was found and not by listening.
 *
 * `setTargetAtTime` rather than a ramp because it starts from whatever the
 * value happens to be at `at` — which is the point: there is a phrase running
 * and this must not need to know where in it we are. τ=0.10 is −40dB in 0.46s.
 */
function stopDrone(at, immediate) {
  const d = drone;
  if (immediate) drone = null;
  if (!d || !g) return;
  const t = Math.max(at, ctxNow() + 0.02);
  if (d.stopAt != null && d.stopAt <= t) return;
  d.stopAt = t;
  note(`stopDrone at ${t.toFixed(3)}`);
  try {
    cancelFrom(d.dg.gain, t);
    d.dg.gain.setTargetAtTime(0, t, 0.10);
    for (const n of d.nodes) n.stop(t + 0.7);
  } catch { /* a node already stopped is the state we wanted */ }
}

/** Air across a ramp: one wide, very quiet noise swell. Both synth beds use it.
 *  Named `air()` until §P10; it is not ART §7's air layer and never was — see
 *  air() above for the one that is. */
function hangarSwell(t) {
  if (!g || !mix || mode === 'off') return;
  const bg = gain(0);
  const bp = filt('bandpass', 480, 0.55);
  const p = panner(rng() < 0.5 ? -0.5 : 0.5);
  const n = noiseSrc('pink', t, 2.6, 0.55);
  n.connect(bp); bp.connect(bg); bg.connect(p); p.connect(mix.synth);
  glide(bp.frequency, t, 380, 900, 1.6);
  swell(bg.gain, t, mode === 'menu' ? 0.05 : 0.016, 1.0, 0.3, 1.2);
  n.onended = () => { try { bp.disconnect(); } catch { /* already gone */ } };
}

/* ── offline render (§8, so the score is measured and not asserted) ─────── */

/**
 * Schedule `seconds` of one SYNTHESISED bed into an OfflineAudioContext graph,
 * through the real voices and the real music bus. engine.renderMusic() wraps
 * this; tools/audiotest.mjs renders it next to every sting so "the music sits
 * under the mix" is a number.
 *
 * The module's live state is saved and restored around the call. That is safe
 * because everything below is synchronous — there is no await between the swap
 * and the restore, so a live game cannot observe the offline state.
 */
export function offline(graph, seconds, which) {
  const save = { g, mix, mode, rng, drone, nextSwell, bar, motif, synthLive, synthOffAt };
  g = graph;
  mix = buildMix(graph, 1);
  // The render is the SHIPPED bed at full volume, so it carries the same trim
  // rampOut() applies live — otherwise the number §7 is asserted against is a
  // level nobody ever hears.
  mix.synth.gain.value = which === 'menu' ? MENU_TRIM : MATCH_TRIM;
  mode = which;
  synthLive = true;
  rng = makeRng(`chudopoly-music-${which}`);
  drone = null;
  bar = 0;
  motif = 0;
  try {
    if (which === 'match') {
      startDrone();
      for (let t = 0.05, i = 0; t < seconds; t += BAR, i++) scheduleMatchBar(t, i);
      for (let t = 3; t < seconds; t += 16) hangarSwell(t);
    } else {
      for (let t = 0.05, i = 0; t < seconds; t += BAR, i++) scheduleMenuBar(t, i);
      for (let t = 5; t < seconds; t += 15) hangarSwell(t);
    }
  } finally {
    g = save.g; mix = save.mix; mode = save.mode;
    rng = save.rng; drone = save.drone; nextSwell = save.nextSwell;
    bar = save.bar; motif = save.motif; synthLive = save.synthLive;
    synthOffAt = save.synthOffAt;
  }
}

/**
 * Schedule one RECORDED bed into an offline graph, at its shipped trim and
 * through the same bus (reverb send included). This is how tools/audiotest.mjs
 * measures a file bed against the synthesised one it replaces — the recorded
 * beds changed every number in the mix and the trims below were re-derived
 * against this render rather than guessed.
 *
 * @param {AudioBuffer} buf a trimmed loop region, from decodeTrack()
 */
export function offlineFile(graph, seconds, key, buf) {
  const spec = TRACKS[key];
  if (!spec || !buf) return;
  const m = buildMix(graph, 1);
  const src = graph.ctx.createBufferSource();
  src.buffer = buf;
  src.loop = !spec.oneShot;
  const vg = graph.ctx.createGain();
  vg.gain.value = dbToGain(spec.trimDb);
  src.connect(vg); vg.connect(m.file);
  src.start(0);
  src.stop(seconds);
}

/** Fetch + decode + trim one track into `ctx`, for the harness. Never touches
 *  the module's live buffer cache — a measurement must not warm the game. */
export function decodeTrack(ctx, key) {
  const spec = TRACKS[key];
  if (!spec) return Promise.resolve(null);
  const url = new URL(`../../audio/${spec.file}`, import.meta.url).href;
  return fetch(url, { credentials: 'omit' })
    .then((r) => r.arrayBuffer())
    .then((ab) => ctx.decodeAudioData(ab))
    .then((buf) => trimToLoop(ctx, buf, spec))
    .catch(() => null);
}

/**
 * Run the picker over a list of match keys and return what it chooses, without
 * disturbing the live rotation. Exists so tools/audiotest.mjs can assert the
 * no-repeat property over hundreds of rooms rather than over the two or three a
 * render could exercise — the property IS statistical and cannot be shown any
 * other way.
 */
export function __rotation(keys) {
  const save = { matchKey, lastBed };
  const out = [];
  try {
    lastBed = null;
    for (const k of keys) { matchKey = String(k); out.push(pickMatchTrack()); }
  } finally { matchKey = save.matchKey; lastBed = save.lastBed; }
  return out;
}

/** The track table, for the harness. */
export function tracks() { return Object.keys(TRACKS); }

/**
 * Render one of the four TRANSITIONS offline, through the real transition code.
 *
 * "A transition you did not measure is a transition you did not test" — so this
 * exists rather than a second implementation of the timeline in the harness.
 * The steps are driven against the REAL set()/setTension() entry points and the
 * REAL pump(), with `clockOffset` standing in for an OfflineAudioContext's
 * frozen currentTime; the only thing faked is the passage of time.
 *
 * `bufs` is a {key: AudioBuffer} of already-decoded loop regions, because
 * decoding is async and scheduling here is not.
 *
 * 'hide'/'show' model a backgrounded tab: between them pump() is not called,
 * which is the whole of what backgrounding does to this module (rAF stops —
 * tools/tabaway.mjs measured 1 frame across 133 broadcasts hidden — while the
 * audio thread and the main-thread event loop keep running). The `dead` flags
 * are written by the tick loop below in both states because that is what live
 * onended does: it fires whether or not the tab is visible (proven live in the
 * scratchpad repro — after 33s hidden the voice came back dead).
 *
 * @param {Array<{at:number, do:'menu'|'match'|'arm'|'break'|'lobby'|'off'|'win'|'lose'|'hide'|'show'}>} steps
 */
export async function offlineTransition(graph, seconds, steps, bufs, opts) {
  const save = {
    g, mix, mode, want, rng, drone, nextSwell, bar, motif, synthLive, synthOffAt, synthUpAt,
    nextBar, tension, bedWant, matchTrack, matchKey, voices, pendingArm, busyUntil,
    clockOffset, level, ceremony, lastBed, buffers: new Map(buffers),
  };
  // Rendered at full user volume, like every other offline render here, so the
  // numbers compare directly against renderMusic()'s rather than against a
  // settings value the harness happens to have.
  level = 1;
  g = graph;
  mix = buildMix(graph, 1);
  /* SOLO, for the harness only. 'synth' mutes the recorded layer and the
   * stinger/riser bus so what is left is exactly the synthesised BED — which is
   * how "what level is the synth layer at while a recorded bed is at full"
   * becomes a number instead of an argument. It mutes buses; it changes no
   * automation, so the thing measured is the thing that plays. */
  // Disconnected, not zeroed: setSynthTrim() re-ramps mix.synth.gain on every
  // mode change, so a muted GAIN does not stay muted. A missing edge does.
  if (opts && opts.solo === 'synth') { mix.file.disconnect(); mix.fx.disconnect(); }
  if (opts && opts.solo === 'file') { mix.synthEnv.disconnect(); mix.fx.disconnect(); }
  buffers.clear();
  for (const [k, v] of Object.entries(bufs || {})) {
    // A track scheduled to ARRIVE must not start out resident, or the render
    // takes raiseBed()'s fast path and the arrival path goes untested — which is
    // exactly how this gate came to be missing.
    if (opts && opts.arrive && opts.arrive[k] != null) continue;
    if (v) buffers.set(k, v);
  }
  voices = [];
  drone = null;
  mode = 'off';
  want = 'off';
  tension = false;
  bedWant = null;
  // A forced bed, so a render can exercise ONE named track instead of whichever
  // the rotation happens to pick. start('match') only calls the picker when
  // matchTrack is unset, so presetting it is the whole mechanism.
  matchTrack = (opts && opts.bed) || null;
  // Reset, not carried: pickMatchTrack() remembers the last bed, so without this
  // a render depended on how many renders had run before it in the same page —
  // two identical calls chose different beds and a control render stopped being
  // a control. Renders are reproducible; the live rotation is restored below.
  lastBed = null;
  pendingArm = false;
  ceremony = null;
  busyUntil = 0;
  synthLive = true;
  synthOffAt = 0;
  synthUpAt = 0;
  bar = 0;
  motif = 0;
  nextBar = 0;
  clockOffset = 0;
  offlineLog = [];
  offlineArrive = (opts && opts.arrive) || null;
  offlinePending.length = 0;
  const held = sub;
  sub = null;
  offlineMode = true;                   // clock.subscribe() must not run offline
  try {
    const queue = steps.slice().sort((a, b) => a.at - b.at);
    let qi = 0;
    let rafLive = true;                 // 'hide'/'show' — see the doc comment
    for (let t = 0; t < seconds; t += 0.05) {
      clockOffset = t;
      // What src.onended does live: a source whose scheduled end has passed is
      // dead, visible tab or not. Offline the real onended only fires after the
      // whole render, so the flag is written here, on the same clock the stop
      // was scheduled against.
      for (const v of voices) if (!v.dead && t >= v.endAt) v.dead = true;
      // The render models an instant network for everything EXCEPT the tracks
      // named in `arrive`: release() legitimately evicts a bed on a mode change
      // (see LOAD POLICY) and a live client would re-fetch it, which cannot
      // happen inside a schedule. Put those back so what gets measured is the
      // transition and not the fallback.
      for (const k of Object.keys(bufs || {})) {
        if (offlineArrive && offlineArrive[k] != null) continue;
        if (bufs[k] && !buffers.has(k)) buffers.set(k, bufs[k]);
      }
      // …and hand over the ones that are scheduled to show up now, through the
      // real promise handoff() is waiting on.
      for (let i = offlinePending.length - 1; i >= 0; i--) {
        const q = offlinePending[i];
        if (t + 1e-9 < q.at) continue;
        offlinePending.splice(i, 1);
        const buf = bufs ? bufs[q.key] : null;
        if (buf) buffers.set(q.key, buf); else failed.add(q.key);
        loading.delete(q.key);
        q.resolve(buf || null);
      }
      // Drain the microtask queue so those continuations run at THIS
      // clockOffset rather than after the whole render has been scheduled.
      for (let d = 0; d < 4; d++) await Promise.resolve();
      while (qi < queue.length && queue[qi].at <= t) {
        const s = queue[qi++];
        if (s.do === 'arm') setTension(true);
        else if (s.do === 'break') setTension(false);
        else if (s.do === 'off') set('off');
        else if (s.do === 'win') ending('victory');
        else if (s.do === 'lose') ending('defeat');
        else if (s.do === 'hide') rafLive = false;
        else if (s.do === 'show') rafLive = true;
        else set(s.do === 'lobby' ? 'menu' : s.do, { key: s.key || 'offline' });
      }
      if (rafLive) pump();
    }
  } finally {
    sub = held;
    offlineMode = false;
    offlineArrive = null;
    offlinePending.length = 0;
    g = save.g; mix = save.mix; mode = save.mode; want = save.want;
    rng = save.rng; drone = save.drone; nextSwell = save.nextSwell;
    bar = save.bar; motif = save.motif; synthLive = save.synthLive;
    synthOffAt = save.synthOffAt; synthUpAt = save.synthUpAt;
    nextBar = save.nextBar; tension = save.tension;
    bedWant = save.bedWant; matchTrack = save.matchTrack; matchKey = save.matchKey;
    voices = save.voices; pendingArm = save.pendingArm; busyUntil = save.busyUntil;
    clockOffset = save.clockOffset; level = save.level; ceremony = save.ceremony;
    lastBed = save.lastBed;
    buffers.clear();
    for (const [k, v] of save.buffers) buffers.set(k, v);
  }
  const log = offlineLog;
  offlineLog = null;
  return log;
}
