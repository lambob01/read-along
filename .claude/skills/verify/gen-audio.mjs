import { writeFileSync } from 'fs';
const RATE = 44100, SECONDS = 60;
const pcm = new Int16Array(RATE * SECONDS);
for (let s = 0; s < SECONDS; s++) {
  const freq = 300 + 100 * s;            // second s -> its own tone
  for (let i = 0; i < RATE; i++) {
    const t = i / RATE;
    // fade each second in/out so boundaries are clean
    const env = Math.min(1, Math.min(t, 1 - t) * 40);
    pcm[s * RATE + i] = Math.round(Math.sin(2 * Math.PI * freq * t) * 0.6 * env * 32767);
  }
}
const buf = Buffer.alloc(44 + pcm.length * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + pcm.length * 2, 4); buf.write('WAVE', 8);
buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(pcm.length * 2, 40);
Buffer.from(pcm.buffer).copy(buf, 44);
writeFileSync('tone.wav', buf);
console.log('wrote tone.wav', buf.length, 'bytes');
