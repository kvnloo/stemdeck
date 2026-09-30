// Slowed playback must never let the chunk sources run dry (#722).
//
// With SoundTouch stretching, sources play at 1x and the worklet buffers what
// it has not yet released, so below 1x the sources are used up faster than the
// output playhead moves. The lookahead gate compared against the output
// playhead, overstated its margin by (1 - rate) seconds every second, and at
// 0.75x the sources ran dry about fifty seconds in.
//
// So this plays a two minute track against a fake clock, one tick every 100 ms,
// and checks at every tick that the scheduled sources still reach past "now".
// The bug needs minutes of playback to show, which the 6 second e2e fixture
// cannot provide, hence a node test with a synthetic WAV.

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

const RATE = 8000;
const TRACK_SEC = 120;
const PLAY_SEC = 100;
const STEP_SEC = 0.1;

class FakeParam {
  constructor(value = 0) { this.value = value; }
}

class FakeNode {
  constructor(ctx, type) {
    this.ctx = ctx;
    this.type = type;
    ctx.nodes.push(this);
  }

  connect(destination) { return destination; }
  disconnect() {}
}

class FakeGain extends FakeNode {
  constructor(ctx) {
    super(ctx, 'gain');
    this.gain = {
      value: 1,
      setTargetAtTime: (value) => { this.gain.value = value; },
    };
  }
}

class FakeAnalyser extends FakeNode {
  constructor(ctx) {
    super(ctx, 'analyser');
    this.fftSize = 1024;
  }
}

// Records where each source starts and how much of its buffer it plays, which
// is all the check below needs to know when the feed runs out.
class FakeSource extends FakeNode {
  constructor(ctx) {
    super(ctx, 'source');
    this.playbackRate = new FakeParam(1);
    this.buffer = null;
  }

  start(when, offset = 0) {
    const played = (this.buffer.duration - offset) / this.playbackRate.value;
    this.ctx.fedUntil = Math.max(this.ctx.fedUntil, when + played);
  }

  stop() {}
}

class FakeContext {
  constructor({ worklet }) {
    this.nodes = [];
    this.currentTime = 0;
    this.sampleRate = 44100;
    this.state = 'running';
    this.fedUntil = 0;
    this.destination = new FakeNode(this, 'destination');
    this.audioWorklet = worklet ? { addModule: async () => {} } : null;
  }

  createGain() { return new FakeGain(this); }
  createAnalyser() { return new FakeAnalyser(this); }
  createBufferSource() { return new FakeSource(this); }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { duration: length / sampleRate, getChannelData: (channel) => data[channel] };
  }
  async resume() {}
  async close() {}
  addEventListener() {}
  removeEventListener() {}
}

class FakeWorkletNode extends FakeNode {
  constructor(ctx) {
    super(ctx, 'worklet');
    this.parameters = new Map([['tempo', new FakeParam(1)]]);
    this.port = { postMessage() {} };
    queueMicrotask(() => this.port.onmessage?.({ data: { type: 'latency', frames: 6541 } }));
  }
}

let pendingTick = null;
globalThis.window = { AudioContext: FakeContext };
globalThis.AudioWorkletNode = FakeWorkletNode;
globalThis.requestAnimationFrame = (cb) => { pendingTick = cb; return 1; };
globalThis.cancelAnimationFrame = () => { pendingTick = null; };

// Mono 16-bit silence. Only the length matters, and a low rate keeps it small.
function wavBytes(seconds) {
  const dataBytes = seconds * RATE * 2;
  const bytes = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(bytes);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  return new Uint8Array(bytes);
}

const WAV = wavBytes(TRACK_SEC);
globalThis.fetch = async (_url, options = {}) => {
  const match = /bytes=(\d+)-(\d+)/.exec(options.headers?.Range || '');
  const start = match ? Number(match[1]) : 0;
  const end = match ? Math.min(Number(match[2]), WAV.length - 1) : WAV.length - 1;
  const slice = WAV.slice(start, end + 1);
  return {
    ok: true,
    status: match ? 206 : 200,
    headers: { get: (name) => name === 'Content-Range' ? `bytes ${start}-${end}/${WAV.length}` : null },
    arrayBuffer: async () => slice.buffer,
  };
};

const { createChunkedAudioEngine } = await import('../../static/js/chunkedAudioEngine.js');

// Enough turns of the event loop for a chunk fetch and decode to settle.
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};

async function verify(label, { worklet, rate }) {
  const ctx = new FakeContext({ worklet });
  const engine = createChunkedAudioEngine([{ name: 'vocals', url: '/vocals.wav' }], { context: ctx });
  check(`${label}: engine becomes ready`, await engine.ready);
  check(
    `${label}: runs on the expected path`,
    engine.supportsPitchShift() === worklet,
  );
  engine.setPlaybackRate(rate);
  await engine.play();

  let dryAt = null;
  while (ctx.currentTime < PLAY_SEC) {
    ctx.currentTime += STEP_SEC;
    const tick = pendingTick;
    pendingTick = null;
    tick?.();
    await settle();
    if (dryAt === null && ctx.fedUntil < ctx.currentTime) dryAt = ctx.currentTime;
  }
  check(
    `${label}: sources never run dry over ${PLAY_SEC} s`,
    dryAt === null,
    `ran dry at ${dryAt?.toFixed(1)} s`,
  );
  engine.destroy();
}

await verify('SoundTouch at 1x', { worklet: true, rate: 1 });
await verify('SoundTouch at 0.75x', { worklet: true, rate: 0.75 });
await verify('tape effect at 0.75x', { worklet: false, rate: 0.75 });

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
