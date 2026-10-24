// Writes the stand-in aarti files used until licensed recordings are
// approved (issue #58). Each is a slow, pitched bell pattern rather than
// singing, so nobody can mistake it for a real recording. Run with
// `node scripts/make-aarti-placeholders.mjs`; output is deterministic.
import { writeFileSync } from 'node:fs';

const SAMPLE_RATE = 8000;
const SECONDS = 24;
const STRIKE_EVERY = 2;

// A different bell pitch per song keeps the three placeholders audibly distinct.
const PLACEHOLDERS = [
  { file: 'PLACEHOLDER-om-jai-jagdish-hare.wav', hz: 440 },
  { file: 'PLACEHOLDER-jai-lakshmi-mata.wav', hz: 523.25 },
  { file: 'PLACEHOLDER-jai-ganesh-deva.wav', hz: 587.33 },
];

function wav(hz) {
  const frames = SAMPLE_RATE * SECONDS;
  const out = Buffer.alloc(44 + frames);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + frames, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(SAMPLE_RATE, 24);
  out.writeUInt32LE(SAMPLE_RATE, 28); // byte rate: 1 byte per frame
  out.writeUInt16LE(1, 32);
  out.writeUInt16LE(8, 34); // unsigned 8-bit
  out.write('data', 36);
  out.writeUInt32LE(frames, 40);
  for (let i = 0; i < frames; i++) {
    const t = i / SAMPLE_RATE;
    const since = t % STRIKE_EVERY;
    const envelope = Math.exp(-since * 2.5) * Math.min(1, since * 200);
    const tone = Math.sin(2 * Math.PI * hz * t) + 0.3 * Math.sin(2 * Math.PI * hz * 2.76 * t);
    out.writeUInt8(Math.round(128 + 70 * envelope * tone), 44 + i);
  }
  return out;
}

for (const { file, hz } of PLACEHOLDERS) {
  writeFileSync(new URL(`../src/audio/aarti/placeholders/${file}`, import.meta.url), wav(hz));
}
