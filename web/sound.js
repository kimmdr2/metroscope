// Sounds of the train you're following: running noise between stations, the train pulling in,
// and pulling out again. Real recordings (see README for credits).

const FILES = { run: "sounds/run-loop.mp3", arrive: "sounds/arrive.mp3", depart: "sounds/depart.mp3" };
// The departure recording opens with ~8s of doors closing on the platform; the visible train is
// already moving by the time we know it left, so start where the motors pick up.
const DEPART_FROM = 8.5;

let ctx = null;
let master = null;
let buffers = null;
let run = null; // { src, gain }
let enabled = false;
let oneShot = null;

async function setup() {
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);
  const load = async (url) => ctx.decodeAudioData(await (await fetch(new URL(url, import.meta.url))).arrayBuffer());
  buffers = Object.fromEntries(await Promise.all(Object.entries(FILES).map(async ([k, url]) => [k, await load(url)])));
}

export async function setSound(on) {
  enabled = on;
  if (on) {
    if (!ctx) await setup();
    await ctx.resume();
  } else {
    stopAll();
    await ctx?.suspend();
  }
}

function ensureRun() {
  if (run || !buffers) return;
  const src = ctx.createBufferSource();
  src.buffer = buffers.run;
  src.loop = true;
  // Skip the encoder padding at both ends so the loop seam stays silent.
  src.loopStart = 0.06;
  src.loopEnd = buffers.run.duration - 0.06;
  const gain = ctx.createGain();
  gain.gain.value = 0;
  src.connect(gain).connect(master);
  src.start(0, 0.06);
  run = { src, gain };
}

function play(name, offset = 0, volume = 1) {
  if (!enabled || !buffers) return;
  oneShot?.stop();
  const src = ctx.createBufferSource();
  src.buffer = buffers[name];
  const gain = ctx.createGain();
  gain.gain.value = volume;
  src.connect(gain).connect(master);
  src.start(0, offset);
  src.onended = () => oneShot === src && (oneShot = null);
  oneShot = src;
}

/**
 * Called every frame while following a train.
 * `speed` m/s (shown motion); `event` is "arrive", "depart" or null.
 */
export function followSound(speed, event) {
  if (!enabled || !buffers) return;
  ensureRun();
  // Running noise swells with speed and ducks under the arrival/departure recordings.
  const target = oneShot ? 0.15 : Math.min(1, speed / 14) * 0.8;
  run.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.6);
  if (event === "arrive") play("arrive", 0, 1);
  if (event === "depart") play("depart", DEPART_FROM, 0.9);
}

export function stopAll() {
  oneShot?.stop();
  oneShot = null;
  if (run) {
    run.src.stop();
    run = null;
  }
}

export const soundEnabled = () => enabled;
