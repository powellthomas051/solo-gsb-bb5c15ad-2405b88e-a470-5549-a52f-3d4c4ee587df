import type { AudioBufferLike, Peaks } from '../types';

const PEAKS_RATE = 200; // peaks per second

/**
 * Compute min/max peak pairs at a fixed rate from decoded audio.
 * ~200 peaks/sec keeps rendering cheap at any zoom level.
 */
export function computePeaks(buffer: AudioBufferLike): Peaks {
  const rate = PEAKS_RATE;
  const duration = buffer.duration;
  const count = Math.max(1, Math.ceil(duration * rate));
  const min = new Float32Array(count);
  const max = new Float32Array(count);

  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
    channels.push(buffer.getChannelData(c));
  }
  const sampleRate = buffer.sampleRate;
  const samplesPerPeak = sampleRate / rate;

  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * samplesPerPeak);
    const end = Math.min(buffer.length, Math.ceil((i + 1) * samplesPerPeak));
    let lo = 0;
    let hi = 0;
    for (const data of channels) {
      // stride to keep per-peak work bounded on very long files
      const step = Math.max(1, Math.floor((end - start) / 256));
      for (let s = start; s < end; s += step) {
        const v = data[s];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[i] = lo;
    max[i] = hi;
  }
  return { min, max, rate, duration };
}
