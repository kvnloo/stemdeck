// Kicks must not come out doubled at slowed speeds (#728).
//
// Below 1x consecutive WSOLA sequences overlap, and an attack in the overlap is
// played twice. At 0.75x a kick came out as a flam roughly 50 ms long. The
// tempo stage now carries straight on past an attack instead of replaying it,
// and borrows the time that costs.
//
// Ground truth comes from the signal, not from a detector: a synthetic track of
// 40 kicks over a sustained chord, so the output must hold exactly 40 attacks.
// The processor is driven exactly as an AudioWorklet would drive it.
//
// Run:  node tests/js/tempo-attacks.test.mjs

import { readFileSync } from 'node:fs';

const SR = 44100;
const BLOCK = 128;
const TEMPO = 0.75;
const KICKS = 40;
const KICK_EVERY = 0.5;
const INPUT_COUNT = 13;
const ZERO_INPUT = 6;
// The processor's own MAX_BORROW_MS, in output time, plus a few milliseconds
// of measurement slack.
const MAX_SHIFT = 0.1 / TEMPO + 0.005;

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
  }
}

const SRC = readFileSync(new URL('../../static/vendor/soundtouch-processor.js', import.meta.url), 'utf8');

function load() {
  let Cls = null;
  new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor', SRC)(
    SR,
    class { constructor() { this.port = { onmessage: null, postMessage() {} }; } },
    (_name, c) => { Cls = c; },
  );
  return Cls;
}

/** A kick is a 3 kHz click and a 60 Hz thump, over an A minor chord that never stops. */
function track() {
  const n = Math.round((KICKS * KICK_EVERY + 0.5) * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    x[i] = 0.08 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 261.63 * t) + Math.sin(2 * Math.PI * 329.63 * t));
  }
  for (let k = 0; k < KICKS; k++) {
    const at = Math.round((0.25 + k * KICK_EVERY) * SR);
    for (let i = 0; i < 0.15 * SR && at + i < n; i++) {
      const t = i / SR;
      const click = t < 0.003 ? 0.5 * Math.sin(2 * Math.PI * 3000 * t) * (1 - t / 0.003) : 0;
      x[at + i] += click + 0.6 * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t / 0.04);
    }
  }
  return x;
}

function stretch(x) {
  const Processor = load();
  const p = new Processor();
  const total = Math.round(x.length / TEMPO) + SR;
  const out = new Float32Array(Math.ceil(total / BLOCK) * BLOCK);
  const params = { tempo: new Float32Array([TEMPO]) };
  for (let pos = 0; pos < out.length; pos += BLOCK) {
    const block = new Float32Array(BLOCK);
    if (pos < x.length) block.set(x.subarray(pos, Math.min(pos + BLOCK, x.length)));
    const inputs = Array.from({ length: INPUT_COUNT }, (_, k) => (k === ZERO_INPUT ? [block, block] : []));
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    p.process(inputs, [[l, r]], params);
    out.set(l, pos);
  }
  return out;
}

/**
 * Attack times in seconds: peaks of the click band's 1 ms envelope above a
 * third of the loudest, at least 10 ms apart. The chord is too low to reach
 * it, so each peak is a click, whether first played or replayed.
 */
function attacks(y) {
  const hop = Math.round(SR * 0.001);
  const env = [];
  for (let i = hop; i + hop <= y.length; i += hop) {
    let e = 0;
    for (let j = 0; j < hop; j++) {
      const d = y[i + j] - y[i + j - 1];
      e += d * d;
    }
    env.push(e);
  }
  const top = Math.max(...env);
  const out = [];
  for (let f = 1; f + 1 < env.length; f++) {
    if (env[f] < top / 3 || env[f] < env[f - 1] || env[f] < env[f + 1]) continue;
    const t = (f + 1) * hop / SR;
    if (out.length && t - out.at(-1) < 0.01) continue;
    out.push(t);
  }
  return out;
}

const input = track();
check('the probe sees every kick in the input', attacks(input).length === KICKS, `saw ${attacks(input).length}`);

const found = attacks(stretch(input));
check(
  `every kick comes out once at ${TEMPO}x`,
  found.length === KICKS,
  `heard ${found.length} attacks for ${KICKS} kicks`,
);

// Borrowed time is paid back, so each kick lands within the loan of where an
// exact clock puts it. The first kick fixes the stage's latency.
const shifts = found.slice(0, KICKS).map((t, k) => t - found[0] - (k * KICK_EVERY) / TEMPO);
const worst = Math.max(...shifts.map(Math.abs));
check(
  'no kick drifts further than the borrow limit',
  worst <= MAX_SHIFT,
  `worst ${(worst * 1000).toFixed(1)} ms`,
);
check(
  'the last kick is back on the clock',
  Math.abs(shifts.at(-1)) <= MAX_SHIFT,
  `${(shifts.at(-1) * 1000).toFixed(1)} ms`,
);

// Borrowing moves a chain's clock. The pitch stages are aligned sample for
// sample with the unpitched drums, so only the shared tempo stage may do it.
const enabled = [...SRC.matchAll(/new Wsola\([^)]*keepAttacks: true/g)].length;
const tempoStage = /this\._tempo = new Wsola\(sampleRate, \{ keepAttacks: true \}\)/.test(SRC);
check('only the shared tempo stage keeps attacks', enabled === 1 && tempoStage, `enabled in ${enabled} places`);

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
