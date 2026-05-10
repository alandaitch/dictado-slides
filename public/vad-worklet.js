// Minimal energy-based VAD running in an AudioWorklet. Posts RMS levels
// back to the main thread every ~5 ms. The main thread owns the speech/
// silence state machine to keep this side dumb and stable.
class EnergyVAD extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / ch.length);
    // Copy samples so the main thread keeps them after the buffer is recycled.
    const copy = ch.slice();
    this.port.postMessage({ rms, samples: copy }, [copy.buffer]);
    return true;
  }
}
registerProcessor("energy-vad", EnergyVAD);
