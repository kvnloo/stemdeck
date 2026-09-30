// Loading the worklet, and how late its output runs, for both audio engines.
//
// Both engines drive the same processor and used to carry their own copy of
// its latency. Signalsmith Stretch (#729) made that a formula that depends on
// the tempo and on which stage loaded, and a third copy of it would drift.

const CORE_URL = "/vendor/signalsmith-stretch.js";
const PROCESSOR_URL = "/vendor/soundtouch-processor.js";

/**
 * Add the Signalsmith core, then the processor.
 *
 * The core is optional. A browser without WebAssembly in worklets, or a CSP
 * without 'wasm-unsafe-eval', fails here, and the processor then keeps WSOLA
 * as its tempo stage. Only the processor failing fails the whole thing.
 */
export async function loadStretchWorklet(audioWorklet) {
  try {
    await audioWorklet.addModule(CORE_URL);
  } catch (err) {
    console.warn("[tempoStage] Signalsmith core did not load, keeping WSOLA:", err);
  }
  await audioWorklet.addModule(PROCESSOR_URL);
}

// WSOLA's tempo stage, as the engines have always counted it.
function wsolaLatencySeconds(sampleRate) {
  const needed = Math.round(0.012 * sampleRate)
    + Math.round(0.028 * sampleRate)
    + Math.round(0.082 * sampleRate);
  return Math.floor(needed / 128) * 128 / sampleRate;
}

/**
 * Seconds between a source sample entering the worklet and it being heard.
 *
 * @param {object} p
 * @param {number} p.workletFrames  the processor's `latency` message: the
 *   priming every bus goes through once the worklet is doing anything
 * @param {object|null} p.stage     the processor's latest `tempoStage` message
 * @param {number} p.rate           playback rate
 * @param {boolean} p.transposed    whether any lane is off its own key
 * @param {number} p.sampleRate
 */
export function pipelineLatencySeconds({ workletFrames, stage, rate, transposed, sampleRate }) {
  const tempoActive = Math.abs(rate - 1) >= 1e-3;
  // The pitch buses only buffer once something is actually transposed. Until
  // then the worklet hands its input straight back, with no delay to correct.
  const pitchSeconds = transposed ? workletFrames / sampleRate : 0;
  if (!tempoActive) return pitchSeconds;
  if (stage?.stage === "signalsmith") {
    // The priming and the core's input side are counted in input samples, so
    // they stretch with the tempo; its output side does not. Measured against
    // the processor end to end, this lands within a millisecond.
    return ((workletFrames + stage.inputFrames) / rate + stage.outputFrames) / sampleRate;
  }
  return pitchSeconds + wsolaLatencySeconds(sampleRate);
}
