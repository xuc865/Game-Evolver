#!/usr/bin/env node
/**
 * tools/audiotest.mjs — offline render of the sfx bank (§7, §8).
 *
 * Renders each sound through an OfflineAudioContext inside the page, so the
 * real synthesis graph is measured rather than a Node reimplementation of it.
 *
 * Asserts:
 *   • peak ≤ 0 dBFS on every sound and on the summed worst case — §7 makes
 *     "no clipping" a graph invariant, not a mixing preference
 *   • the set-progress chime ladder is monotonically ASCENDING in pitch — §7
 *     names it as the positive feedback signal; a ladder that dips reads as a
 *     mistake to the player even when the game state is good
 *   • the sour cue's fundamental sits BELOW chime-0 — the "you are being
 *     stolen from" treatment must be unmistakable against the reward tone
 *   • A CARD SOUND CUTS THROUGH THE MUSIC (6): every cue in §7's card-tactile
 *     vocabulary clears every in-match bed by 6dB in the cue's own loudest
 *     octave. This replaced a peak-vs-peak comparison that read PASS on a build
 *     the owner could not hear the music in — see the note there
 *   • the two menu-screen beds are the same loudness (6b), because they
 *     crossfade into each other
 *   • the four bed TRANSITIONS contain no click at any scheduled seam and no
 *     dead air (8). Both real bugs found in the P10 round were found here.
 *   • the synthesised layer is ABSENT under a recorded bed, and is the WHOLE
 *     score when the recording is withheld (9) — both halves, because a fix
 *     that silences the fallback is worse than the bug it fixes
 *   • the recording actually ARRIVES when the buffer lands mid-render (11) —
 *     the path every player takes on the first use of a track, and the one
 *     every other assertion here skips
 *   • the four match beds rotate, never repeat back to back, and hold a
 *     25±2.5% share each over 4000 rooms (12)
 *   • a bed whose pass ran out while rAF was parked (hidden tab) comes back
 *     when the clock does (13) — the owner's "music stops and won't play at
 *     all", reproduced live before this existed
 *   • a suspended AudioContext is retaken on the next gesture (14) — the
 *     other permanent-silence mechanism, and the only live-context assertion
 *     in the file: everything above renders offline and so cannot see it
 *
 * Needs the audio engine (P5) to expose a render hook. Exits 2 until then.
 */
import {
  SEED, parseArgs, launchBrowser, openPage, requireBridge, reporter,
  green, red, yellow, dim, bold, EXIT_PASS, EXIT_FAIL, EXIT_SKIP,
} from './lib/harness.mjs';
import { startServer } from './serve.mjs';

const args = parseArgs();
const seed = args.seed ? Number(args.seed) : SEED;

/** Chime ladder names, in the order the set-progress feedback plays them. */
const LADDER = ['set_progress_0', 'set_progress_1', 'set_progress_2', 'set_progress_3'];
const SOUR = ['sour', 'stolen', 'pay'];

const r = reporter('audiotest' + dim('  §7 offline render'));
const server = await startServer({ seed });
let browser = null;
let code = EXIT_PASS;

try {
  // The autoplay flag exists for assertions 13b/14, which drive a LIVE
  // AudioContext in a page with no harness recorder (the recorder makes
  // engine.init() a permanent no-op, which is why every prior assertion here
  // was blind to anything that only happens to a running context). It changes
  // nothing for the OfflineAudioContext renders.
  browser = await launchBrowser(['--autoplay-policy=no-user-gesture-required']);
  const h = await openPage(browser, `${server.url}/?harness=1&seed=${seed}&mute=1`);
  await requireBridge(h.page, 8000);

  const audioReady = await h.page.evaluate(() =>
    !!(window.__CHUD.audio && typeof window.__CHUD.audio.renderOffline === 'function' &&
       typeof window.__CHUD.audio.list === 'function'));
  if (!audioReady) {
    console.log(yellow(bold('  PENDING CLIENT AUDIO')) +
      ' — __CHUD.audio.renderOffline(name, seconds) / .list() not exposed yet (P5, §7)');
    console.log(dim('    HARNESS REQUEST TO P5: expose { list(): string[], renderOffline(name, seconds):' +
      ' Promise<Float32Array|{channels:Float32Array[], sampleRate:number}> } on __CHUD.audio,'));
    console.log(dim('    rendering the real bus chain (bus → compressor → soft-clip → master) in an OfflineAudioContext.'));
    await h.close();
    await browser.close();
    await server.stop();
    process.exit(EXIT_SKIP);
  }

  const names = await h.page.evaluate(() => window.__CHUD.audio.list());
  r.pass(`${names.length} sound(s) in the bank`);

  /**
   * Renders one sound and returns peak plus the dominant frequency, measured by
   * a naive DFT over a coarse bin set — cheap, and only has to rank tones
   * against each other, not name them.
   */
  const analyse = (name) => h.page.evaluate(async (n) => {
    const out = await window.__CHUD.audio.renderOffline(n, 1.5);
    const buf = out instanceof Float32Array ? out : out.channels[0];
    const sampleRate = out instanceof Float32Array ? 48000 : out.sampleRate;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));

    // Dominant partial: scan 60–2000Hz in 5Hz steps over the first 0.35s, where
    // a card-game cue's fundamental lives before the tail decays.
    const win = Math.min(buf.length, Math.floor(sampleRate * 0.35));
    let bestF = 0, bestMag = 0;
    for (let f = 60; f <= 2000; f += 5) {
      let re = 0, im = 0;
      const w = 2 * Math.PI * f / sampleRate;
      for (let i = 0; i < win; i += 2) {
        re += buf[i] * Math.cos(w * i);
        im += buf[i] * Math.sin(w * i);
      }
      const mag = Math.hypot(re, im);
      if (mag > bestMag) { bestMag = mag; bestF = f; }
    }
    return { peak, freq: bestF, samples: buf.length, sampleRate };
  }, name);

  /* ---- 1. nothing clips --------------------------------------------------- */
  let clipped = 0;
  const measured = {};
  for (const n of names) {
    const m = await analyse(n);
    measured[n] = m;
    const dbfs = m.peak > 0 ? 20 * Math.log10(m.peak) : -Infinity;
    if (m.peak > 1.0) {
      clipped++;
      r.fail(`${n} peaks at ${dbfs.toFixed(2)} dBFS (>0) — §7 makes no-clipping a graph invariant`);
    }
  }
  if (!clipped) {
    const loudest = Object.entries(measured).sort((a, b) => b[1].peak - a[1].peak)[0];
    r.pass(`peak ≤ 0 dBFS across ${names.length} sound(s) ` +
      dim(`(loudest ${loudest[0]} at ${(20 * Math.log10(loudest[1].peak)).toFixed(2)} dBFS)`));
  }

  /* ---- 2. the chime ladder ascends ---------------------------------------- */
  const ladder = LADDER.filter((n) => names.includes(n));
  if (ladder.length < 2) {
    r.warn(`chime ladder not found (looked for ${LADDER.join(', ')}) — §7 requires a monotonic pentatonic ladder`);
  } else {
    const freqs = ladder.map((n) => measured[n].freq);
    const ascending = freqs.every((f, i) => i === 0 || f > freqs[i - 1]);
    if (ascending) r.pass(`chime ladder ascends ${dim(freqs.map((f) => `${f}Hz`).join(' → '))}`);
    else r.fail(`chime ladder is not monotonic: ${freqs.map((f, i) => `${ladder[i]}=${f}Hz`).join(', ')}`);
  }

  /* ---- 3. the sour cue sits under chime-0 --------------------------------- */
  const sourName = SOUR.find((n) => names.includes(n));
  const chime0 = ladder.length ? measured[ladder[0]].freq : null;
  if (!sourName) {
    r.warn(`no sour cue found (looked for ${SOUR.join(', ')}) — §7 requires a distinctly sour treatment`);
  } else if (chime0 == null) {
    r.warn('no chime-0 to compare the sour cue against');
  } else if (measured[sourName].freq < chime0) {
    r.pass(`sour cue "${sourName}" ${measured[sourName].freq}Hz is below chime-0 ${chime0}Hz`);
  } else {
    r.fail(`sour cue "${sourName}" ${measured[sourName].freq}Hz is NOT below chime-0 ${chime0}Hz — ` +
      'reward and punishment read alike');
  }

  /* ---- 4. losses are LOUDER than furniture (round-1 audio regression) ------
   * MEASURED in round 1: being robbed rendered QUIETER than a HUD timer tick.
   * The mix is what tells a player which events matter; a loss that sits under
   * the furniture teaches that losing does not. Peak, not fundamental — this is
   * about presence in the mix, not pitch.                                     */
  const LOSSES = ['sour', 'sour_broke', 'sour_pay'];
  const FURNITURE = ['shuffle_riffle', 'card_snap', 'timer_critical'];
  const lossNames = LOSSES.filter((n) => names.includes(n));
  const furnNames = FURNITURE.filter((n) => names.includes(n));
  if (!lossNames.length || !furnNames.length) {
    r.warn(`loss/furniture comparison skipped (losses: ${lossNames.join(',') || 'none'}; `
      + `furniture: ${furnNames.join(',') || 'none'})`);
  } else {
    const quiet = [];
    for (const loss of lossNames) {
      for (const furn of furnNames) {
        if (measured[loss].peak <= measured[furn].peak) {
          quiet.push(`${loss} ${(20 * Math.log10(measured[loss].peak)).toFixed(1)}dBFS `
            + `≤ ${furn} ${(20 * Math.log10(measured[furn].peak)).toFixed(1)}dBFS`);
        }
      }
    }
    if (quiet.length) {
      r.fail(`${quiet.length} loss cue(s) render no louder than table furniture — `
        + 'being robbed must not be quieter than a HUD tick (§7)');
      for (const q of quiet) r.info(q);
    } else {
      r.pass(`every loss cue (${lossNames.join(', ')}) is louder than `
        + `${furnNames.join(', ')} ${dim(lossNames.map((n) => `${n}=${(20 * Math.log10(measured[n].peak)).toFixed(1)}dB`).join(' '))}`);
    }
  }

  /* ---- 5. under overflow, meaning outranks furniture ----------------------
   * §7 caps voices with weights, and gives priority voices a HIGHER cap. The
   * failure that produces is a set completion silenced because four card
   * slides got there first — the same shape as the 42% sfx loss the motion
   * agent measured, one layer down.
   *
   * The absolute assertion — `stats().droppedPriority === 0` over a real game —
   * lives in playtest.mjs's animated pass, where a real event stream exists.
   * Here the burst is SYNTHETIC, so an absolute zero would only measure how
   * hostile I chose to be: at 100 cues/second every cap must drop something,
   * and asserting otherwise would be a demand no mixer can meet. What is
   * asserted here is the ORDERING, which must hold at any density: when the
   * budget overflows, priority voices survive at a strictly better rate than
   * furniture, and the big moments in a burst are not the first thing cut.   */
  const hasMix = await h.page.evaluate(() => typeof window.__CHUD.audio.renderMix === 'function');
  if (!hasMix) {
    r.warn('__CHUD.audio.renderMix absent — priority-ordering assertion not run');
  } else {
    const burst = await h.page.evaluate(async (bank) => {
      const BIGNAMES = ['set_progress_3', 'sour', 'sour_broke', 'chud_hit', 'win', 'fanfare'];
      const bigs = bank.filter((n) => BIGNAMES.includes(n));
      const filler = bank.filter((n) => !BIGNAMES.includes(n));
      const run = async (fillEveryMs, bigEveryMs) => {
        const entries = [];
        let i = 0;
        for (let t = 0; t < 6000; t += fillEveryMs, i++) {
          entries.push({ name: filler[i % filler.length] || bank[0], t });
          if (t % bigEveryMs === 0 && bigs.length) {
            entries.push({ name: bigs[(t / bigEveryMs) % bigs.length], t: t + 2, big: true });
          }
        }
        const out = await window.__CHUD.audio.renderMix(entries, 7);
        const nBig = entries.filter((e) => e.big).length;
        return { v: out.voices, total: entries.length, nBig, nFill: entries.length - nBig };
      };
      return { hostile: await run(10, 200), realistic: await run(120, 600) };
    }, names);

    // The hostile burst only has to prove the cap ENGAGES. Its drop counts are
    // not gated on: `droppedPriority` counts the engine's own priority flag,
    // which many bank sounds carry, so a synthetic 100-cue/second flood cannot
    // be turned into an honest per-class rate from outside the engine — and a
    // rate computed wrong is worse than none. Tried it: it reported 547%.
    const b = burst.hostile;
    if (!b?.v) {
      r.warn('renderMix returned no voice accounting — voice-cap assertions not run');
    } else if (b.v.dropped === 0 && b.v.gated === 0) {
      r.fail(`a ${b.total}-cue/6s flood never exceeded the voice budget — `
        + 'the cap is not engaging, so nothing below proves anything');
    } else {
      r.pass(`the voice cap engages under flood ${dim(`(${b.v.dropped} dropped, ${b.v.gated} rate-gated of ${b.total})`)}`);
    }

    // THE ASSERTION: at the game's real worst case — one broadcast every 120ms,
    // the cadence the motion agent measured the collapse at — nothing priority
    // may drop. playtest.mjs asserts the same counter live, on a real game.
    const rb = burst.realistic;
    if (rb?.v) {
      if (rb.v.peak === 0) {
        r.fail('the realistic burst claimed no voices at all — assertion is vacuous');
      } else if (rb.v.droppedPriority === 0) {
        r.pass(`no priority voice dropped at the real 120ms broadcast cadence `
          + dim(`(${rb.total} cues, peak load ${rb.v.peak}/${rb.v.cap})`));
      } else {
        r.fail(`${rb.v.droppedPriority} priority voice(s) dropped at the ordinary 120ms cadence — `
          + 'a big moment is being silenced during normal play (§7)');
      }
    }
  }

  /* ---- 6. A CARD SOUND MUST CUT THROUGH THE MUSIC -------------------------
   *
   * This slot used to hold "the match bed's PEAK is below card_slide's PEAK".
   * That assertion was written for a synthesised drone and it did not survive
   * contact with the room: it read PASS on the build the owner played, and the
   * owner's verdict was "cant really hear anything at all music wise".
   *
   * It was measuring the wrong quantity, and the reason is measurable. Peak
   * says nothing about masking — two signals with identical peaks mask each
   * other completely differently depending on where their energy sits — and a
   * mastered recording carries ~19dB of crest against the synth bed's 12.8, so
   * matching PEAKS between them makes the recording 6dB quieter in loudness.
   * What the assertion was always FOR is the thing its own failure message
   * said: a card must be audible over the bed. So it measures that.
   *
   * THE TEST. For each cue in §7's card-tactile vocabulary — the list §7 writes
   * down verbatim, "shuffle riffle, card slide, card snap-down, flip,
   * chip/coin", plus prop_place which shares the snap — find the octave band
   * that cue's own energy peaks in, measured over the cue's own active window
   * (onset to −30dB off its peak, so the number is not a function of how long
   * the render happened to be). Every IN-MATCH bed must sit at least MASK_FLOOR
   * dB below the cue in that band.
   *
   * 6dB: inside one critical band a probe becomes reliably audible a few dB
   * above the masker's spectrum level, and a transient against a sustained bed
   * gets more margin than that from its own onset. 6 leaves room on top and it
   * is a FLOOR, not a target — all four in-match beds are trimmed to sit within
   * a decibel of it, so it is the binding constraint on how loud the music is
   * allowed to be, which is exactly what the old assertion failed to be.
   *
   * MENU-screen beds are excluded, and that is a scope statement rather than an
   * exemption: cards only exist inside #screen-game, so not one of these cues
   * can fire while the menu or lobby bed is playing. They are held against each
   * other instead (6b) — they crossfade into one another, so a level difference
   * between them is an audible handoff, and the shipped build had 7.8dB of it.
   */
  const hasMusic = await h.page.evaluate(() => typeof window.__CHUD.audio.renderMusic === 'function');
  const MASK_FLOOR = 6;
  const GATE_CUES = ['shuffle_riffle', 'card_slide', 'card_snap', 'card_flip',
    'chip', 'prop_place'].filter((n) => names.includes(n));
  const IN_MATCH = ['match', 'match1', 'match2', 'match3', 'match4', 'final'];
  const MENU_BEDS = ['menu', 'lobby'];

  if (!hasMusic) {
    r.warn('__CHUD.audio.renderMusic absent — music/sfx masking not asserted');
  } else if (GATE_CUES.length < 4) {
    r.warn(`only ${GATE_CUES.length} of §7's card-tactile cues are in the bank — masking not asserted`);
  } else {
    const band = await h.page.evaluate(async ([cues, beds]) => {
      /* radix-2 FFT, in place */
      function fft(re, im) {
        const n = re.length;
        for (let i = 1, j = 0; i < n; i++) {
          let bit = n >> 1;
          for (; j & bit; bit >>= 1) j ^= bit;
          j ^= bit;
          if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
        }
        for (let len = 2; len <= n; len <<= 1) {
          const ang = -2 * Math.PI / len;
          const wr = Math.cos(ang), wi = Math.sin(ang);
          for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
              const ur = re[i + k], ui = im[i + k];
              const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
              const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
              re[i + k] = ur + vr; im[i + k] = ui + vi;
              re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
              const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
            }
          }
        }
      }
      const EDGES = [180, 355, 710, 1420, 2840, 5680, 11360];
      const LABEL = ['250', '500', '1k', '2k', '4k', '8k'];
      const dbp = (p) => (p > 0 ? 10 * Math.log10(p) : -Infinity);
      /** Welch octave-band POWERS (10log10) over [a,b) — N=1024 so a 30ms cue
       *  still yields a whole frame; short windows are zero-padded, not skipped. */
      function bands(x, a, b, sr) {
        const N = 1024;
        const pow = new Float64Array(LABEL.length);
        let frames = 0;
        for (let s = a; s < Math.max(a + N, b); s += N / 2) {
          const re = new Float64Array(N), im = new Float64Array(N);
          let any = false;
          for (let i = 0; i < N; i++) {
            if (s + i >= b) break;
            re[i] = x[s + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
            any = true;
          }
          if (!any) break;
          fft(re, im);
          for (let k = 1; k < N / 2; k++) {
            const f = k * sr / N;
            for (let e = 0; e < LABEL.length; e++) {
              if (f >= EDGES[e] && f < EDGES[e + 1]) {
                pow[e] += (re[k] * re[k] + im[k] * im[k]) * 2 / (N * N * 0.375);
                break;
              }
            }
          }
          frames++;
          if (b - a < N) break;
        }
        return Array.from(pow, (p) => dbp(frames ? p / frames : 0));
      }
      const mono = (o) => {
        const L = o.channels[0], R = o.channels[1];
        const m = new Float64Array(L.length);
        for (let i = 0; i < L.length; i++) m[i] = (L[i] + R[i]) * 0.5;
        return m;
      };
      const out = { cues: {}, beds: {}, labels: LABEL };
      for (const n of cues) {
        const o = await window.__CHUD.audio.renderOffline(n, 1.5);
        const m = mono(o);
        // The window the cue is actually SOUNDING in: onset to -30dB off peak.
        const W = Math.round(o.sampleRate * 0.005);
        let pk = 0;
        const env = [];
        for (let i = 0; i + W <= m.length; i += W) {
          let s = 0; for (let j = i; j < i + W; j++) s += m[j] * m[j];
          const rr = Math.sqrt(s / W); env.push(rr); if (rr > pk) pk = rr;
        }
        let last = 0;
        for (let i = 0; i < env.length; i++) if (env[i] > pk / 31.6) last = i;
        out.cues[n] = bands(m, 0, Math.min(m.length, (last + 1) * W), o.sampleRate);
      }
      for (const w of beds) {
        try {
          const o = await window.__CHUD.audio.renderMusic(w, 24);
          const m = mono(o);
          // Bands off the mono mixdown (masking is a spectrum question), but
          // LEVEL off both channels: these beds run L/R correlations from 0.16
          // to 0.89, and a mono mixdown silently penalises the wide ones by up
          // to 3dB, which is a level difference nobody can hear reported as one
          // that matters.
          let s = 0, n = 0;
          for (const c of o.channels) for (let i = 0; i < c.length; i++) { s += c[i] * c[i]; n++; }
          out.beds[w] = { bands: bands(m, 0, m.length, o.sampleRate), rms: 10 * Math.log10(s / n) };
        } catch (e) { out.beds[w] = { error: String((e && e.message) || e) }; }
      }
      return out;
    }, [GATE_CUES, [...IN_MATCH, ...MENU_BEDS]]);

    const broken = Object.entries(band.beds).filter(([, v]) => v.error);
    if (broken.length) {
      r.fail(`${broken.length} music bed(s) failed to render: `
        + broken.map(([k, v]) => `${k} (${v.error})`).join(', '));
    }
    const dom = {};
    for (const c of GATE_CUES) {
      let bi = 0;
      for (let i = 1; i < band.cues[c].length; i++) if (band.cues[c][i] > band.cues[c][bi]) bi = i;
      dom[c] = bi;
    }
    const masked = [];
    const worst = [];
    for (const w of IN_MATCH) {
      const b = band.beds[w];
      if (!b || b.error) continue;
      let low = Infinity, lowCue = '';
      for (const c of GATE_CUES) {
        const m = band.cues[c][dom[c]] - b.bands[dom[c]];
        if (!Number.isFinite(m)) continue;
        if (m < low) { low = m; lowCue = c; }
        if (m < MASK_FLOOR) {
          masked.push(`${w} masks ${c} in the ${band.labels[dom[c]]} band: ${m.toFixed(1)}dB of margin, floor ${MASK_FLOOR}`);
        }
      }
      worst.push(`${w} ${low.toFixed(1)}dB (${lowCue}/${band.labels[dom[lowCue]]})`);
    }
    if (masked.length) {
      r.fail(`${masked.length} cue/bed pair(s) below the ${MASK_FLOOR}dB masking floor — `
        + 'the music is over the card layer (§7)');
      for (const m of masked.slice(0, 8)) r.info(m);
    } else if (worst.length) {
      r.pass(`every §7 card cue clears every in-match bed by ≥${MASK_FLOOR}dB in its own octave `
        + dim(`(tightest per bed: ${worst.join(', ')})`));
    }

    /* ---- 6b. the two menu-screen beds are the same loudness ----------------
     * They crossfade into each other on every boot (synth first, recorded bed
     * when it lands), so a level difference between them is an audible handoff
     * rather than a mix opinion. The shipped build had 7.8dB of it, because the
     * recorded bed had been trimmed to the synth bed's PEAK — the same
     * crest-factor mistake assertion 6 used to make.                          */
    const mm = band.beds.menu, ll = band.beds.lobby;
    if (mm && ll && !mm.error && !ll.error) {
      const d = ll.rms - mm.rms;
      if (Math.abs(d) > 2) {
        r.fail(`the recorded lobby bed is ${d > 0 ? '+' : ''}${d.toFixed(1)}dB against the synthesised `
          + 'menu bed it hands off from — that difference is audible at the handoff');
      } else {
        r.pass(`menu-screen beds match within ${Math.abs(d).toFixed(1)}dB `
          + dim(`(synth ${mm.rms.toFixed(1)}, recorded ${ll.rms.toFixed(1)} dBFS RMS)`));
      }
    }
  }


  /* ---- 8. the four transitions, measured rather than described -------------
   * "A transition you did not measure is a transition you did not test." Each
   * of music.js's four transitions is rendered offline through the real
   * transition code (audio.renderTransition drives set()/setTension() against
   * an OfflineAudioContext) and graded on the two ways a bed change goes wrong:
   *
   *   a CLICK  — a one-sample discontinuity where a source is cut or started.
   *              Graded at the SCHEDULED seam times only, against the render's
   *              own |dx| distribution, because hunting the whole buffer for
   *              "the biggest jump" only ever finds the loudest transient in
   *              the music. 2x the 99.99th percentile is the bar.
   *   a HOLE   — dead air. This is what caught the two real bugs in the round:
   *              stopDrone() cancelling from `now` instead of from its
   *              scheduled time (6.0s at -114 dBFS), and the synth transport
   *              not re-basing on a mode change (1.3s at -105 dBFS).
   *
   * The hole is graded AGAINST A CONTROL: the same bed, same length, no
   * transition. A flat "no gap longer than N" was a threshold on the MUSIC, not
   * on the transition, and it went off the moment a sparser bed entered the
   * rotation — match-3 "Night Watch" is deliberately the loosest of the four
   * (13.5% thin, p5 −37.7 dB against its own median) and its own quiet stretches
   * ran 0.7s under the bar with nothing wrong at all. What this has to answer is
   * "did the transition make a hole the bed does not already have", so it asks
   * exactly that, and the answer is allowed 0.3s of slack for the crossfade
   * itself.                                                                    */
  const hasTrans = await h.page.evaluate(() => typeof window.__CHUD.audio.renderTransition === 'function');
  if (!hasTrans) {
    r.warn('__CHUD.audio.renderTransition absent — the four transitions are not measured');
  } else {
    const PLANS = [
      ['lobby→match', [{ at: 0, do: 'menu' }, { at: 12, do: 'match' }], 26],
      ['match→final', [{ at: 0, do: 'match' }, { at: 16, do: 'arm' }], 26],
      ['final→match', [{ at: 0, do: 'match' }, { at: 10, do: 'arm' }, { at: 18, do: 'break' }], 28],
      ['match→lobby', [{ at: 0, do: 'match' }, { at: 16, do: 'lobby' }], 28],
    ];
    const bad = [];
    const good = [];
    for (const [label, steps, seconds] of PLANS) {
      const m = await h.page.evaluate(async ([st, sec]) => {
        const o = await window.__CHUD.audio.renderTransition(st, sec);
        const sr = o.sampleRate, L = o.channels[0], R = o.channels[1];
        const db = (v) => (v > 0 ? 20 * Math.log10(v) : -120);
        const dx = [];
        for (let i = 1; i < L.length; i += 3) dx.push(Math.abs(L[i] - L[i - 1]));
        dx.sort((a, b) => a - b);
        const p9999 = dx[Math.floor(dx.length * 0.9999)] || 1e-9;
        let worst = 0, worstAt = 0;
        for (const line of o.log) {
          const mm = / at (\d+\.\d+)/.exec(line);
          if (!mm) continue;
          const t = Number(mm[1]);
          const a = Math.max(1, Math.round((t - 0.01) * sr));
          const b = Math.min(L.length, Math.round((t + 0.01) * sr));
          let mx = 0;
          for (let i = a; i < b; i++) { const d = Math.abs(L[i] - L[i - 1]); if (d > mx) mx = d; }
          if (mx / p9999 > worst) { worst = mx / p9999; worstAt = t; }
        }
        // Dead air, in 100ms frames. -62 dBFS is 37dB under the quietest bed
        // this render contains, i.e. unambiguously nothing.
        const W = Math.round(sr * 0.1);
        let hole = 0, run = 0, holeAt = 0;
        const end = Math.round(sr * (sec - 1.5));      // ignore the fade at the tail
        for (let i = 0; i + W <= end; i += W) {
          let s = 0;
          for (let j = i; j < i + W; j++) { const x = (L[j] + R[j]) * 0.5; s += x * x; }
          if (db(Math.sqrt(s / W)) < -62) {
            run++;
            if (run > hole) { hole = run; holeAt = (i / sr) - (run - 1) * 0.1; }
          } else run = 0;
        }
        return { worst, worstAt, hole: hole * 0.1, holeAt };
      }, [steps, seconds]);
      // The control: the same opening state, no transition, same duration.
      const ctrl = await h.page.evaluate(async ([st, sec]) => {
        const o = await window.__CHUD.audio.renderTransition(st, sec, {});
        const sr = o.sampleRate, L = o.channels[0], R = o.channels[1];
        const db = (v) => (v > 0 ? 20 * Math.log10(v) : -120);
        const W = Math.round(sr * 0.1);
        let hole = 0, run = 0;
        const end = Math.round(sr * (sec - 1.5));
        for (let i = 0; i + W <= end; i += W) {
          let s2 = 0;
          for (let j = i; j < i + W; j++) { const x = (L[j] + R[j]) * 0.5; s2 += x * x; }
          if (db(Math.sqrt(s2 / W)) < -62) { run++; if (run > hole) hole = run; } else run = 0;
        }
        return hole * 0.1;
      }, [[steps[0]], seconds]);
      const allow = Math.max(0.7, ctrl + 0.3);
      if (m.worst > 2) bad.push(`${label}: click at ${m.worstAt.toFixed(2)}s (${m.worst.toFixed(1)}× the render's own p99.99 |dx|)`);
      else if (m.hole > allow) {
        bad.push(`${label}: ${m.hole.toFixed(1)}s of dead air at ${m.holeAt.toFixed(1)}s — `
          + `the same bed with no transition holds ${ctrl.toFixed(1)}s`);
      } else good.push(`${label} ${m.worst.toFixed(2)}×/${m.hole.toFixed(1)}s`);
    }
    if (bad.length) {
      r.fail(`${bad.length} of ${PLANS.length} bed transition(s) are audibly broken`);
      for (const b of bad) r.info(b);
    } else {
      r.pass(`all ${PLANS.length} bed transitions are clean ${dim(`(seam |dx| / dead air: ${good.join(', ')})`)}`);
    }
  }

  /* ---- 9. THE SYNTH LAYER IS A GAP-FILLER, NOT AN UNDERLAY ----------------
   * Owner, on 2cc5a4a: "when switching to the game and also on the main menu I
   * think the synthesized music tracks are still audible slightly". They were.
   * Not a leak — raiseBed() used to bring the synthesised bed up
   * UNCONDITIONALLY and only then cross to the recording, so it played a full
   * phrase on every entrance even with the file already in memory (measured:
   * 5.2s entering a match, 3.3s on the menu, with nothing to cover).
   *
   * TWO assertions, and the second is why this is not one. A fix that silences
   * the synth permanently is worse than the bug — it is the offline path, the
   * failed-fetch path and the whole score for a player with no network — so the
   * gate holds BOTH directions:
   *
   *   a) with the recording resident, the synth bus is ≥60dB under the file bus
   *   b) with the recording withheld, the synth bus IS the output
   *
   * Each bus is soloed by DISCONNECTING the others inside offlineTransition(),
   * not by zeroing a gain — setSynthTrim() re-ramps mix.synth.gain on every mode
   * change, so a muted gain does not stay muted. A missing edge does.          */
  if (!hasTrans) {
    r.warn('__CHUD.audio.renderTransition absent — the synth/file handoff is not measured');
  } else {
    const SOLO_FLOOR = 60;
    // Withhold EVERY track, read off the module's own table rather than a list
    // written here. A hardcoded list went stale the moment two beds were added:
    // the picker chose one of the new ones, that one was resident, and the
    // "fallback" scene quietly stopped exercising the fallback.
    const allTracks = await h.page.evaluate(() =>
      (typeof window.__CHUD.audio.tracks === 'function' ? window.__CHUD.audio.tracks() : []));
    const SCENES = [
      ['menu', [{ at: 0, do: 'menu' }], 26, allTracks],
      ['match', [{ at: 0, do: 'match' }], 26, allTracks],
      ['climax', [{ at: 0, do: 'match' }, { at: 12, do: 'arm' }], 30, allTracks],
    ];
    /* The WHOLE render, deliberately. A window that starts after the handoff has
     * settled is vacuous against the bug this exists for: the shipped defect was
     * five seconds of synthesised bed at the ENTRANCE, after which the layer
     * genuinely did fall silent. Measured over 0..end, a resident recording must
     * mean the synth bus never produced a sample. */
    const level = (steps, secs, solo, withhold) => h.page.evaluate(async ([st, sec, so, wh]) => {
      const o = await window.__CHUD.audio.renderTransition(st, sec, { solo: so || undefined, withhold: wh });
      const L = o.channels[0], R = o.channels[1];
      let s = 0;
      for (let i = 0; i < L.length; i++) { const x = (L[i] + R[i]) * 0.5; s += x * x; }
      const rms = Math.sqrt(s / L.length);
      return rms > 0 ? 20 * Math.log10(rms) : -200;
    }, [steps, secs, solo, withhold || []]);

    const bleeding = [];
    const quiet = [];
    const dead = [];
    const alive = [];
    for (const [name, steps, secs, withhold] of SCENES) {
      const fileSolo = await level(steps, secs, 'file', []);
      const synthSolo = await level(steps, secs, 'synth', []);
      const margin = fileSolo - synthSolo;
      if (margin < SOLO_FLOOR) {
        bleeding.push(`${name}: synth ${synthSolo.toFixed(1)} dBFS under a recorded bed at `
          + `${fileSolo.toFixed(1)} — only ${margin.toFixed(1)}dB down, floor ${SOLO_FLOOR}`);
      } else {
        quiet.push(`${name} ${margin > 100 ? 'silent' : `−${margin.toFixed(0)}dB`}`);
      }
      // …and with the recording withheld, the synth must BE the score.
      const fullBack = await level(steps, secs, null, withhold);
      const synthBack = await level(steps, secs, 'synth', withhold);
      if (synthBack < -100) {
        dead.push(`${name}: with the recording withheld the synth renders silence — the fallback is gone`);
      } else if (Math.abs(fullBack - synthBack) > 1) {
        dead.push(`${name}: fallback mix ${fullBack.toFixed(1)} but synth solo ${synthBack.toFixed(1)} dBFS — `
          + 'something other than the synth is carrying the fallback');
      } else {
        alive.push(`${name} ${synthBack.toFixed(1)}dBFS`);
      }
    }
    if (bleeding.length) {
      r.fail(`${bleeding.length} scene(s) play the synthesised bed under a recorded one — `
        + 'the synth layer covers a gap, it is not an underlay');
      for (const x of bleeding) r.info(x);
    } else {
      r.pass(`the synth layer is absent under every recorded bed ${dim(`(${quiet.join(', ')})`)}`);
    }
    if (dead.length) {
      r.fail(`${dead.length} scene(s) lost the procedural fallback — §0.3's amendment requires it to `
        + 'be the whole score when a fetch fails');
      for (const x of dead) r.info(x);
    } else {
      r.pass(`the procedural fallback still carries every scene alone ${dim(`(${alive.join(', ')})`)}`);
    }
  }

  /* ---- 10. THE ENDGAME PAIR ------------------------------------------------
   * §0.3's cap moved four → six for victory.opus / defeat.opus. They are not
   * beds and the owner's requirement is behavioural: "let it play/finish for the
   * winners even when rematching or going back to main menu". So the supersede
   * rule is what gets asserted, not just the level:
   *
   *   victory survives every menu-side move and yields only to a match starting
   *   defeat  ends when the player leaves the overlay
   *
   * The asymmetry is the point — a win is something you carry out with you, a
   * loss is acknowledged and then closed. Levels are held against two things,
   * because no card cue fires on that screen so the §7 masking gate above does
   * not bind them: (a) the stings that land on the same instant, at the SAME 6dB
   * in-band floor, because the sting is the moment and the music is under it;
   * and (b) the menu beds, because a ceremony quieter than the lobby loop is not
   * a payoff.                                                                 */
  if (hasTrans && hasMusic) {
    const PLANS = [
      ['victory survives Rematch into a lobby',
        [{ at: 0, do: 'match' }, { at: 6, do: 'win' }, { at: 10, do: 'lobby' }], 20, false],
      ['victory survives the main menu too',
        [{ at: 0, do: 'match' }, { at: 6, do: 'win' }, { at: 10, do: 'lobby' }, { at: 14, do: 'lobby' }], 22, false],
      ['a match supersedes victory',
        [{ at: 0, do: 'match' }, { at: 6, do: 'win' }, { at: 10, do: 'lobby' }, { at: 14, do: 'match' }], 22, true],
      ['defeat ends when the overlay is left',
        [{ at: 0, do: 'match' }, { at: 6, do: 'lose' }, { at: 10, do: 'lobby' }], 20, true],
      ['a second win restarts the ceremony',
        [{ at: 0, do: 'match' }, { at: 6, do: 'win' }, { at: 12, do: 'win' }], 22, true],
    ];
    const wrong = [];
    const right = [];
    for (const [label, steps, secs, mustStop] of PLANS) {
      const log = await h.page.evaluate(async ([st, sec]) => {
        const o = await window.__CHUD.audio.renderTransition(st, sec, {});
        return o.log;
      }, [steps, secs]);
      const started = log.filter((l) => l.includes('startCeremony')).length;
      const stopped = log.some((l) => l.includes('stopCeremony'));
      if (!started) wrong.push(`${label}: no ceremony ever started`);
      else if (stopped !== mustStop) {
        wrong.push(`${label}: ceremony was ${stopped ? 'superseded' : 'left running'} and should have been `
          + `${mustStop ? 'superseded' : 'left running'}`);
      } else right.push(label.split(' ')[0] + (mustStop ? '✂' : '▸'));
    }
    if (wrong.length) {
      r.fail(`${wrong.length} endgame supersede rule(s) are wrong`);
      for (const w of wrong) r.info(w);
    } else {
      r.pass(`the endgame supersede rule holds in all ${PLANS.length} cases `
        + dim('(victory outlives its screen, defeat and a new match end it)'));
    }

    /* Level: the stings must clear the cue under them, and the cue must not be
     * quieter than the menu music it replaces. */
    /* ABOVE 300Hz, not broadband — the same trap the card-cue gate had to climb
     * out of in round 2. The menu beds are a 55Hz drone under a bass-heavy
     * lobby track and the endgame pair is dense mid-forward material; compared
     * broadband the ceremony reads 1-2dB QUIETER while carrying 2.3 to 7.7dB
     * more energy in the band a laptop or a phone actually reproduces. The
     * question here is "does the payoff sound bigger than the lobby loop", and
     * that is a loudness question, so it is asked where loudness lives. */
    const ends = await h.page.evaluate(async () => {
      const db = (v) => (v > 0 ? 20 * Math.log10(v) : -180);
      const out = {};
      for (const w of ['menu', 'victory', 'defeat']) {
        const o = await window.__CHUD.audio.renderMusic(w, 40);
        const a = Math.exp(-2 * Math.PI * 300 / o.sampleRate);
        let hs = 0, n = 0, pk = 0;
        for (const c of o.channels) {
          let prev = 0, hp = 0;
          for (let i = 0; i < c.length; i++) {
            const v = Math.abs(c[i]); if (v > pk) pk = v;
            hp = a * (hp + c[i] - prev); prev = c[i];
            hs += hp * hp; n++;
          }
        }
        out[w] = { rms: db(Math.sqrt(hs / n)), peak: db(pk) };
      }
      return out;
    });
    const soft = ['victory', 'defeat'].filter((k) => ends[k].rms < ends.menu.rms - 1);
    if (soft.length) {
      r.fail(`${soft.map((k) => `${k} ${ends[k].rms.toFixed(1)}`).join(', ')} dBFS is quieter than the menu bed `
        + `${ends.menu.rms.toFixed(1)} — the endgame cue is the payoff, not background`);
    } else {
      r.pass(`the endgame pair carries the screen ${dim(`(>300Hz RMS: victory ${ends.victory.rms.toFixed(1)}, `
        + `defeat ${ends.defeat.rms.toFixed(1)} vs menu bed ${ends.menu.rms.toFixed(1)} dBFS)`)}`);
    }
  }

  /* ---- 11. THE ARRIVAL PATH ------------------------------------------------
   * Every assertion above renders with the buffers already resident, which
   * exercises raiseBed()'s fast path — `buffers.has(key)` true → startFile. A
   * real player NEVER takes that path on the first use of a track: the buffer is
   * absent, the synth is scheduled behind SYNTH_GRACE, and handoff() → load() →
   * crossToFile() is what actually puts the recording on. Nothing rendered that,
   * because no offline scene had a buffer show up mid-render, so a session could
   * have had no music at all with this whole file green.
   *
   * offlineTransition's `arrive` map fixes that: the named tracks start ABSENT
   * and are handed over at a scheduled moment through the real promise handoff()
   * is waiting on, with clockOffset set to that moment. The assertion is simply
   * that the recording is at level shortly after it lands, at both a fast
   * arrival (inside the grace, where the fallback should never sound) and a slow
   * one (past it, where the fallback covers and must then hand over).           */
  if (hasTrans && hasMusic) {
    const CASES = [
      ['lobby, fast arrival', [{ at: 0, do: 'menu' }], 20, { lobby: 0.2 }, 0.2, null],
      ['lobby, slow arrival', [{ at: 0, do: 'menu' }], 20, { lobby: 3.0 }, 3.0, null],
      ['match bed, fast arrival', [{ at: 0, do: 'match' }], 20,
        { match1: 0.2, match2: 0.2, match3: 0.2, match4: 0.2 }, 0.2, null],
      // EVERY match bed on the slow path, not just whichever one the picker
      // happens to land on: the rotation makes that a coin toss, and a bed that
      // never arrives would hide behind three that do. `bed` forces the choice.
      ...['match1', 'match2', 'match3', 'match4'].map((k) => [
        `${k}, slow arrival`, [{ at: 0, do: 'match' }], 20, { [k]: 3.0 }, 3.0, k,
      ]),
      ['climax, arrival on arm', [{ at: 0, do: 'match' }, { at: 8, do: 'arm' }], 22, { final: 8.2 }, 8.2, null],
    ];
    const SETTLE = 4.0;          // seconds after the buffer lands
    const bad = [];
    const good = [];
    for (const [label, steps, secs, arrive, at, bed] of CASES) {
      const m = await h.page.evaluate(async ([st, sec, ar, t0, bd]) => {
        const db = (v) => (v > 0 ? 20 * Math.log10(v) : -200);
        const o = await window.__CHUD.audio.renderTransition(st, sec, { solo: 'file', arrive: ar, bed: bd || undefined });
        const sr = o.sampleRate, L = o.channels[0], R = o.channels[1];
        const a = Math.round((t0 + 4.0) * sr), b = Math.min(L.length, Math.round((sec - 1) * sr));
        let s = 0, n = 0;
        for (let i = a; i < b; i++) { const x = (L[i] + R[i]) * 0.5; s += x * x; n++; }
        return { rms: db(Math.sqrt(s / Math.max(1, n))), log: o.log };
      }, [steps, secs, arrive, at, bed]);
      // -70 dBFS is 30dB under the quietest bed here: this is "is it playing at
      // all", not a level assertion. The level assertions are 6 and 6b.
      if (m.rms < -70) {
        bad.push(`${label}: file bus is ${m.rms.toFixed(1)} dBFS ${SETTLE}s after the buffer landed — `
          + `the recording never arrived (log: ${m.log.join(' | ') || 'nothing scheduled'})`);
      } else good.push(`${label.split(',')[0]} ${m.rms.toFixed(0)}`);
    }
    if (bad.length) {
      r.fail(`${bad.length} of ${CASES.length} arrival path(s) never put the recording on — `
        + 'this is the path every player takes on the first use of a track');
      for (const x of bad) r.info(x);
    } else {
      r.pass(`the recording arrives and reaches level in all ${CASES.length} cases `
        + dim(`(file bus dBFS: ${good.join(', ')})`));
    }
  }

  /* ---- 12. THE ROTATION NEVER REPEATS ITSELF -------------------------------
   * §0.3's cap went to eight for two more match beds, and the reason was not
   * variety for its own sake: a fair pick over TWO beds plays the same one twice
   * running half the time, which is what the owner heard as "there is only one
   * track". Four beds do not fix that on their own — a fair pick over four still
   * repeats a quarter of the time. The no-repeat rule in pickMatchTrack() is
   * what fixes it, and this is the only way to show it, because the property is
   * statistical: it holds over hundreds of rooms or it does not hold.
   *
   * Three things are asserted, and the middle one is the point:
   *   every bed is reachable            (a typo in the pool is silent otherwise)
   *   no two consecutive picks are equal
   *   the pool is not badly skewed      (no-repeat leaves three equally likely,
   *                                      so ~25% each over a long run)          */
  const hasRot = await h.page.evaluate(() => typeof window.__CHUD.audio.rotation === 'function');
  if (!hasRot) {
    r.warn('__CHUD.audio.rotation absent — the no-repeat rotation is not asserted');
  } else {
    // 4000, raised from 400: at 400 the per-bed share has a sampling sd of
    // ~2.2 points, so a genuinely fair picker printed 20%–29% and the old
    // 15–40% band could not tell fair from broken. At 4000 the sd is ~0.7
    // points; the picker itself measures 24.8/25.1/25.1/25.0% over 40k keys
    // (chi-square 0.77 against uniform, scratchpad fairness-sim), so the
    // ±2.5-point band below is >3σ of headroom and the keys are deterministic
    // anyway — the number cannot move between runs.
    const N = 4000;
    const seq = await h.page.evaluate((n) => {
      const CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const keys = [];
      // Room-code shaped AND actually distinct. The previous generator
      // (`(i*7 + c*31 + i*i%29) % 32`) moved every character by the same value,
      // so it could only ever emit 32 codes / ~96 keys — the "400 rooms" run
      // was 96 hash draws wearing 400 labels, and its per-bed shares swung ±9
      // points on a picker that is provably uniform. FNV mixing with the HIGH
      // bits folded down fixes it (measured: 3994 distinct codes in 4000; the
      // low bits alone give EIGHT, because a multiply-only hash never diffuses
      // downward). Deterministic, so this number cannot move between runs.
      let hsh = 2166136261 >>> 0;
      const mix = (x) => {
        hsh = Math.imul(hsh ^ x, 16777619) >>> 0;
        return ((hsh ^ (hsh >>> 16)) >>> 0);
      };
      for (let i = 0; i < n; i++) {
        let code = '';
        for (let c = 0; c < 4; c++) code += CH[mix(i * 4 + c) % CH.length];
        keys.push(`${code}#${i % 3}`);
      }
      return window.__CHUD.audio.rotation(keys);
    }, N);
    const beds = await h.page.evaluate(() => window.__CHUD.audio.tracks()
      .filter((k) => /^match\d+$/.test(k)));
    const seen = new Set(seq);
    const missing = beds.filter((b) => !seen.has(b));
    let repeats = 0;
    let firstRepeat = -1;
    for (let i = 1; i < seq.length; i++) {
      if (seq[i] === seq[i - 1]) { repeats++; if (firstRepeat < 0) firstRepeat = i; }
    }
    const counts = beds.map((b) => seq.filter((x) => x === b).length);
    const lo = Math.min(...counts) / seq.length, hi = Math.max(...counts) / seq.length;
    if (missing.length) {
      r.fail(`${missing.join(', ')} never chosen in ${N} rooms — a bed nothing can reach is a bed nobody ships`);
    } else if (repeats) {
      r.fail(`${repeats} back-to-back repeat(s) in ${N} rooms, first at #${firstRepeat} (${seq[firstRepeat]}) — `
        + 'the no-repeat rule is the whole reason the cap moved to eight');
    } else if (lo < 0.225 || hi > 0.275) {
      r.fail(`the rotation is skewed: ${beds.map((b, i) => `${b} ${(100 * counts[i] / seq.length).toFixed(1)}%`).join(', ')} `
        + `over ${N} rooms — every bed must hold 25±2.5% (proven-to-fail: a squared-r pick reads 40.5/34.6/18.9/5.9)`);
    } else {
      r.pass(`${beds.length} beds, zero back-to-back repeats in ${N} rooms `
        + dim(`(${beds.map((b, i) => `${b.replace('match', '')}:${(100 * counts[i] / seq.length).toFixed(0)}%`).join(' ')})`));
    }
  }

  /* ---- 13. THE BED SURVIVES A PARKED CLOCK ---------------------------------
   * OWNER BUG, live play: "occasionally music will stop during gameplay all
   * together and just won't play at all." REPRODUCED (scratchpad repro-stall):
   * a hidden/minimized tab parks rAF, so pump() stops and reloop() cannot arm
   * the next pass; the current pass runs out (29–64s per bed), its onended
   * fires while hidden, and on return leadVoice() is null — reloop()'s guard
   * returns forever, with bedWant set, the buffer resident, and master RMS 0.0.
   * Every render above pumps every 50ms without fail, which is why this file
   * was green while the owner heard silence.
   *
   * 'hide' at 2s parks the pump exactly as a background tab does; match3's
   * trimmed pass (29.09s) runs out inside the window; 'show' at 38s is the
   * player coming back. The bed must be back on its feet shortly after. */
  if (hasTrans) {
    const m = await h.page.evaluate(async () => {
      const db = (v) => (v > 0 ? 20 * Math.log10(v) : -200);
      const o = await window.__CHUD.audio.renderTransition(
        [{ at: 0, do: 'match' }, { at: 2, do: 'hide' }, { at: 38, do: 'show' }],
        46, { bed: 'match3' });
      const sr = o.sampleRate, L = o.channels[0], R = o.channels[1];
      const rms = (a, b) => {
        let s = 0, n = 0;
        for (let i = Math.round(a * sr); i < Math.min(L.length, Math.round(b * sr)); i++) {
          const x = (L[i] + R[i]) * 0.5; s += x * x; n++;
        }
        return db(Math.sqrt(s / Math.max(1, n)));
      };
      // 10..25s: the pass is still sounding while hidden (audio does not stop
      // when a tab hides — if this is silent the render staged the wrong bug).
      // 42..45s: 4s after the return the bed must be BACK.
      return { during: rms(10, 25), after: rms(42, 45), log: o.log };
    });
    if (m.during < -70) {
      r.fail(`parked-clock render is silent at 10–25s (${m.during.toFixed(1)} dBFS) — the bed never `
        + 'started, so the recovery assertion below would be vacuous');
    } else if (m.after < -55) {
      r.fail(`the bed never comes back after a parked clock: ${m.after.toFixed(1)} dBFS at 42–45s `
        + `against ${m.during.toFixed(1)} while it played — the owner's "music stops and won't play at all" `
        + `(log tail: ${m.log.slice(-3).join(' | ')})`);
    } else {
      r.pass(`the bed survives a parked clock ${dim(`(${m.during.toFixed(1)} dBFS playing, `
        + `pass runs out hidden, ${m.after.toFixed(1)} dBFS 4s after return)`)}`);
    }
  }

  /* ---- 14. A SUSPENDED CONTEXT IS RETAKEN ----------------------------------
   * The second stop mechanism, and it takes the card sounds with it: a phone
   * call, Siri, an app switch or an audio-route change puts the context in
   * 'suspended'/'interrupted', and the client had NO resume path — no
   * visibilitychange, no onstatechange, no gesture hook (grep: zero callers of
   * engine.resume()). REPRODUCED live: suspend() then a real click left the
   * context suspended forever.
   *
   * This one needs a LIVE context, so it runs in a second page WITHOUT the
   * harness recorder (which makes init() a no-op). The autoplay flag on the
   * launch stands in for the first gesture; the click is a real, trusted
   * Playwright gesture — the same input the fix's listener must catch. */
  {
    const live = await openPage(browser, `${server.url}/`);
    const state0 = await live.page.evaluate(async () => {
      const engine = await import('/src/audio/engine.js');
      window.__live = { engine, meter: null };
      engine.init();
      window.__live.meter = engine.__meter();
      return window.__live.meter ? window.__live.meter().state : 'no-graph';
    });
    if (state0 !== 'running') {
      r.warn(`live context never reached 'running' (${state0}) — suspension recovery not asserted here`);
    } else {
      await live.page.evaluate(() => window.__live.engine.suspend());
      const st1 = await live.page.evaluate(() => window.__live.meter().state);
      if (st1 === 'running') {
        r.fail('suspend() did not suspend — the recovery assertion below is vacuous');
      } else {
        await live.page.mouse.click(400, 300);
        let st2 = st1;
        for (let i = 0; i < 20 && st2 !== 'running'; i++) {
          await new Promise((res) => setTimeout(res, 100));
          st2 = await live.page.evaluate(() => window.__live.meter().state);
        }
        if (st2 === 'running') {
          r.pass('a suspended context is retaken on the next gesture ' + dim(`(${st1} → ${st2})`));
        } else {
          r.fail(`a suspended context stays ${st2} after a real click — a phone call or app switch `
            + 'silences the whole game until reload');
        }
      }
    }
    await live.close();
  }

  if (h.errors.length) {
    r.fail(`${h.errors.length} console/page error(s) during render`);
    for (const e of h.errors.slice(0, 5)) console.log(red(`      ${e}`));
  }

  await h.close();
  code = r.code;
} catch (e) {
  console.log(red(`  ✗ ${e.stack || e.message}`));
  code = EXIT_FAIL;
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.stop();
}

console.log(code === EXIT_PASS ? green(bold('audiotest: PASS')) : red(bold('audiotest: FAIL')));
process.exit(code);
