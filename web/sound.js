// Arrival chimes. Pitch follows height on screen (north = higher), stereo follows left/right,
// so the sound is a map of what you're looking at.

// Major pentatonic over three octaves, so any combination of arrivals sounds consonant.
const SCALE = [0, 2, 4, 7, 9];
const STEPS = 15;
const MAX_PER_SECOND = 8;

let ctx = null;
let out = null;
let tokens = MAX_PER_SECOND;
let refilled = 0;

function setup() {
  ctx = new AudioContext();
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.ratio.value = 4;
  const master = ctx.createGain();
  master.gain.value = 0.9;

  // Small generated room so overlapping notes blend instead of clicking.
  const verb = ctx.createConvolver();
  const len = ctx.sampleRate * 2.4;
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  }
  verb.buffer = ir;
  const wet = ctx.createGain();
  wet.gain.value = 0.28;

  out = ctx.createGain();
  out.connect(master);
  out.connect(verb).connect(wet).connect(master);
  master.connect(comp).connect(ctx.destination);
}

export async function setSound(on) {
  if (!ctx) setup();
  if (on) await ctx.resume();
  else await ctx.suspend();
}

export const soundOn = () => ctx?.state === "running";

/** x, y in 0..1 screen space. */
export function chime(x, y, bright = false) {
  if (!soundOn()) return;
  const now = ctx.currentTime;
  tokens = Math.min(MAX_PER_SECOND, tokens + (now - refilled) * MAX_PER_SECOND);
  refilled = now;
  if (tokens < 1) return;
  tokens -= 1;

  const step = Math.round((1 - Math.min(1, Math.max(0, y))) * (STEPS - 1));
  const semis = 12 * Math.floor(step / SCALE.length) + SCALE[step % SCALE.length];
  const freq = 220 * 2 ** (semis / 12); // A3 up

  const osc = ctx.createOscillator();
  const overtone = ctx.createOscillator();
  const gain = ctx.createGain();
  const pan = ctx.createStereoPanner();
  osc.type = "triangle";
  osc.frequency.value = freq;
  overtone.type = "sine";
  overtone.frequency.value = freq * (bright ? 3 : 2);
  const og = ctx.createGain();
  og.gain.value = 0.18;
  pan.pan.value = Math.min(1, Math.max(-1, x * 2 - 1)) * 0.8;

  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.06, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.8);
  osc.connect(gain);
  overtone.connect(og).connect(gain);
  gain.connect(pan).connect(out);
  osc.start(now);
  overtone.start(now);
  osc.stop(now + 1.9);
  overtone.stop(now + 1.9);
}
