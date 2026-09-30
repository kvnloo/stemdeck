// The Signalsmith tempo stage (#729).
//
// WSOLA slowed audio by repeating overlapping fragments, heard as an echo on
// everything sustained. The processor now stretches with Signalsmith Stretch
// when its core loads, and keeps WSOLA when it does not. Checked here, with the
// processor driven exactly as an AudioWorklet drives it:
//
//   - the stage is swapped in at a flush, and reported, and only then
//   - the latency the engines compute from that report is the latency measured
//   - kicks come out once each and on time, so nothing drifts
//   - with no core, WSOLA stays, so playback never depends on WebAssembly
//
// Run:  node tests/js/signalsmith-stage.test.mjs

import { readFileSync } from 'node:fs';
import { pipelineLatencySeconds } from '../../static/js/tempoStage.js';

const BLOCK = 128;
const INPUT_COUNT = 13;
const ZERO_INPUT = 6;

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

const vendor = (name) => readFileSync(new URL(`../../static/vendor/${name}`, import.meta.url), 'utf8');
const PROCESSOR = vendor('soundtouch-processor.js');
const CORE = vendor('signalsmith-stretch.js');

/** A processor, with or without the core in its global scope, and its messages. */
async function create(sr, { core }) {
  if (core) new Function(CORE)();
  else delete globalThis.SignalsmithStretchCore;
  let Cls = null;
  const messages = [];
  new Function('sampleRate', 'AudioWorkletProcessor', 'registerProcessor', PROCESSOR)(
    sr,
    class { constructor() { this.port = { postMessage: (m) => messages.push(m) }; } },
    (_name, c) => { Cls = c; },
  );
  const p = new Cls();
  // Instantiating the core is asynchronous; the engine's play() resets the
  // processor well after that, which is what this stands in for.
  await new Promise((resolve) => setTimeout(resolve, 50));
  p.port.onmessage({ data: { type: 'reset' } });
  return { p, messages };
}

/** Run `input` through at `tempo` into the unpitched input; returns the left output. */
function run(p, input, tempo, outLength) {
  const out = new Float32Array(Math.ceil(outLength / BLOCK) * BLOCK);
  const params = { tempo: new Float32Array([tempo]) };
  for (let pos = 0; pos < out.length; pos += BLOCK) {
    const block = new Float32Array(BLOCK);
    if (pos < input.length) block.set(input.subarray(pos, Math.min(pos + BLOCK, input.length)));
    const inputs = Array.from({ length: INPUT_COUNT }, (_, k) => (k === ZERO_INPUT ? [block, block] : []));
    const l = new Float32Array(BLOCK);
    p.process(inputs, [[l, new Float32Array(BLOCK)]], params);
    out.set(l, pos);
  }
  return out;
}

const lastOf = (messages, type) => messages.filter((m) => m.type === type).at(-1);

// --- the stage is swapped in, and says so ---
{
  const { p, messages } = await create(44100, { core: true });
  run(p, new Float32Array(BLOCK), 0.75, BLOCK);
  const stage = lastOf(messages, 'tempoStage');
  check('the core is swapped in at the first flush', stage?.stage === 'signalsmith', `stage ${stage?.stage}`);
  check('its latency is reported in two parts', stage?.inputFrames > 0 && stage?.outputFrames > 0);
}

// --- no core: WSOLA stays ---
{
  const { p, messages } = await create(44100, { core: false });
  run(p, new Float32Array(BLOCK), 0.75, BLOCK);
  check('without the core, WSOLA stays the tempo stage', lastOf(messages, 'tempoStage')?.stage === 'wsola');
}

// --- latency: what the engines compute is what comes out ---
for (const sr of [44100, 48000]) {
  for (const tempo of [0.75, 0.9]) {
    const { p, messages } = await create(sr, { core: true });
    const at = Math.round(sr * 0.5);
    const input = new Float32Array(sr);
    input[at] = 1;
    const out = run(p, input, tempo, sr * 2);
    let peak = 0;
    let peakAt = 0;
    for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > peak) { peak = Math.abs(out[i]); peakAt = i; }
    const measured = (peakAt - at / tempo) / sr;
    const computed = pipelineLatencySeconds({
      workletFrames: lastOf(messages, 'latency').frames,
      stage: lastOf(messages, 'tempoStage'),
      rate: tempo,
      transposed: false,
      sampleRate: sr,
    });
    const error = Math.abs(measured - computed) * 1000;
    check(
      `the computed latency matches at ${sr} Hz, ${tempo}x`,
      error <= 1,
      `measured ${(measured * 1000).toFixed(1)} ms, computed ${(computed * 1000).toFixed(1)} ms`,
    );
  }
}

// --- kicks come out once, and on time ---
{
  const sr = 44100;
  const tempo = 0.75;
  const kicks = 40;
  const every = 0.5;
  const n = Math.round((kicks * every + 0.5) * sr);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    x[i] = 0.08 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 261.63 * t) + Math.sin(2 * Math.PI * 329.63 * t));
  }
  for (let k = 0; k < kicks; k++) {
    const at = Math.round((0.25 + k * every) * sr);
    for (let i = 0; i < 0.15 * sr && at + i < n; i++) {
      const t = i / sr;
      const click = t < 0.003 ? 0.5 * Math.sin(2 * Math.PI * 3000 * t) * (1 - t / 0.003) : 0;
      x[at + i] += click + 0.6 * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t / 0.04);
    }
  }
  const { p } = await create(sr, { core: true });
  const y = run(p, x, tempo, Math.round(n / tempo) + sr);

  // Peaks of the click band's 1 ms envelope above a third of the loudest.
  const hop = Math.round(sr * 0.001);
  const env = [];
  for (let i = hop; i + hop <= y.length; i += hop) {
    let e = 0;
    for (let j = 0; j < hop; j++) e += (y[i + j] - y[i + j - 1]) ** 2;
    env.push(e);
  }
  const top = Math.max(...env);
  const found = [];
  for (let f = 1; f + 1 < env.length; f++) {
    if (env[f] < top / 3 || env[f] < env[f - 1] || env[f] < env[f + 1]) continue;
    const t = (f + 1) * hop / sr;
    if (found.length && t - found.at(-1) < 0.01) continue;
    found.push(t);
  }
  check(`every kick comes out once at ${tempo}x`, found.length === kicks, `heard ${found.length} for ${kicks}`);
  // The input advance carries its fraction, so the last kick lands where an
  // exact clock puts it, not a few samples further each quantum.
  const drift = found.at(-1) - found[0] - ((kicks - 1) * every) / tempo;
  check('the last kick is on the clock', Math.abs(drift) <= 0.002, `${(drift * 1000).toFixed(2)} ms`);
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
