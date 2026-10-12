// metroscope client: draws a loop line as a circle, animates trains, colors headway gaps, plays arrivals.

const SVG_NS = "http://www.w3.org/2000/svg";
const C = 500; // center
const R = 330; // base radius
const TRACK = { 1: R - 16, [-1]: R + 16 }; // 내선 (+1, clockwise) inside, 외선 outside

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, parent) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
};

let stations = [];
let n = 0;
/** id -> { dir, pos (displayed), target, base (last reported), node } */
const trains = new Map();

// Live data arrives only every ~75s, so between updates we nudge trains forward
// at a typical running speed (~2 min per station), capped so we never overshoot far.
const EXTRAPOLATE_SPEED = 1 / 120; // stations per second
const EXTRAPOLATE_MAX = 0.8; // stations
let live = false;
let receivedAt = 0;

const angleOf = (pos) => -Math.PI / 2 + (2 * Math.PI * pos) / n;
const point = (pos, r) => [C + r * Math.cos(angleOf(pos)), C + r * Math.sin(angleOf(pos))];
const wrap = (x) => ((x % n) + n) % n;

// ---------- static layout ----------

function drawLine(snap) {
  stations = snap.stations;
  n = stations.length;
  document.documentElement.style.setProperty("--line", snap.color);
  $("line-name").textContent = snap.line;

  const tracks = $("tracks");
  const st = $("stations");
  tracks.replaceChildren();
  st.replaceChildren();
  for (const r of Object.values(TRACK)) el("circle", { cx: C, cy: C, r, class: "track" }, tracks);

  stations.forEach((name, i) => {
    const [x, y] = point(i, R);
    el("circle", { cx: x, cy: y, r: 5, class: "station-dot" }, st);

    // Radial labels, flipped on the left half so they stay readable.
    const deg = (angleOf(i) * 180) / Math.PI;
    const left = deg > 90 || deg < -90;
    const [lx, ly] = point(i, R + 40);
    const label = el("text", {
      x: lx,
      y: ly,
      class: "station-label",
      "dominant-baseline": "middle",
      "text-anchor": left ? "end" : "start",
      transform: `rotate(${left ? deg + 180 : deg} ${lx} ${ly})`,
    }, st);
    label.textContent = name;
  });
}

// ---------- gaps ----------

function gapColor(g) {
  if (g < 1) return "var(--gap-bunch)";
  if (g >= 6) return "var(--gap-hole)";
  if (g >= 4) return "var(--gap-wide)";
  return "var(--gap-ok)";
}

function arc(p1, p2, r) {
  const span = wrap(p2 - p1);
  const [x1, y1] = point(p1, r);
  const [x2, y2] = point(p1 + span, r);
  return `M ${x1} ${y1} A ${r} ${r} 0 ${span > n / 2 ? 1 : 0} 1 ${x2} ${y2}`;
}

function drawGaps() {
  const g = $("gaps");
  g.replaceChildren();
  const all = [];
  for (const dir of [1, -1]) {
    const list = [...trains.values()].filter((t) => t.dir === dir).sort((a, b) => a.pos - b.pos);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const b = list[(i + 1) % list.length];
      const span = list.length === 1 ? n : wrap(b.pos - a.pos);
      if (span < 0.05) continue;
      el("path", { d: arc(a.pos, a.pos + span, TRACK[dir]), class: "gap", stroke: gapColor(span) }, g);
      all.push({ span, from: a.pos, to: a.pos + span, dir });
    }
  }
  return all;
}

function updateStats(gaps) {
  $("stat-trains").textContent = trains.size;
  if (!gaps.length) return;
  const avg = gaps.reduce((s, x) => s + x.span, 0) / gaps.length;
  $("stat-avg").textContent = `${avg.toFixed(1)}역`;
  const max = gaps.reduce((m, x) => (x.span > m.span ? x : m));
  const name = (p) => stations[Math.round(wrap(p)) % n];
  const dirName = max.dir === 1 ? "내선" : "외선";
  $("stat-max").textContent = `${dirName} ${name(max.from)} → ${name(max.to)} (${max.span.toFixed(1)}역)`;
}

// ---------- trains ----------

function applySnapshot(snap) {
  if (snap.stations.length !== n) drawLine(snap);

  const badge = $("source");
  badge.textContent = snap.source === "live" ? "● LIVE" : "SIMULATION";
  badge.className = `badge ${snap.source}`;
  live = snap.source === "live";
  receivedAt = performance.now();

  const seen = new Set();
  for (const t of snap.trains) {
    seen.add(t.id);
    let cur = trains.get(t.id);
    if (!cur) {
      const node = el("circle", { r: 7, class: `train ${t.dir === 1 ? "in" : "out"}` }, $("trains"));
      node.appendChild(el("title")).textContent = `${t.id}${t.dest ? ` · ${t.dest}행` : ""}`;
      cur = { dir: t.dir, pos: t.pos, target: t.pos, base: t.pos, node };
      trains.set(t.id, cur);
    }
    cur.base = t.pos;
    cur.target = t.pos;
  }
  for (const [id, t] of trains) {
    if (!seen.has(id)) {
      t.node.remove();
      trains.delete(id);
    }
  }

  for (const a of snap.arrivals) onArrival(a);
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const k = 1 - Math.exp(-dt * 2.5); // smooth toward target
  const ahead = live ? Math.min(((now - receivedAt) / 1000) * EXTRAPOLATE_SPEED, EXTRAPOLATE_MAX) : 0;
  for (const t of trains.values()) {
    if (live) t.target = wrap(t.base + t.dir * ahead);
    let d = wrap(t.target - t.pos);
    if (d > n / 2) d -= n; // shortest way around the loop
    t.pos = wrap(t.pos + d * k);
    const [x, y] = point(t.pos, TRACK[t.dir]);
    t.node.setAttribute("cx", x);
    t.node.setAttribute("cy", y);
  }
  if (n) updateStats(drawGaps());
  $("clock").textContent = new Date().toTimeString().slice(0, 8);
  requestAnimationFrame(frame);
}

// ---------- arrivals: ripple + sound ----------

function onArrival({ dir, station }) {
  const [x, y] = point(station, TRACK[dir]);
  const ring = el("circle", { cx: x, cy: y, r: 14, class: "ripple" }, $("ripples"));
  ring.addEventListener("animationend", () => ring.remove());
  playNote(dir, station);
}

let audio = null;
// Major pentatonic, so any combination of arrivals sounds consonant.
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];

function playNote(dir, station) {
  if (!audio) return;
  const semis = SCALE[station % SCALE.length] + (dir === 1 ? 12 : 0);
  const freq = 196 * 2 ** (semis / 12); // G3 base
  const t0 = audio.currentTime;

  const osc = audio.createOscillator();
  const gain = audio.createGain();
  const filter = audio.createBiquadFilter();
  osc.type = "triangle";
  osc.frequency.value = freq;
  filter.type = "lowpass";
  filter.frequency.value = 1800;
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.07, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.6);
  osc.connect(filter).connect(gain).connect(audio.destination);
  osc.start(t0);
  osc.stop(t0 + 1.7);
}

$("sound").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (!audio) audio = new AudioContext();
  const on = btn.getAttribute("aria-pressed") !== "true";
  if (on) await audio.resume();
  else await audio.suspend();
  btn.setAttribute("aria-pressed", String(on));
  btn.textContent = on ? "🔊 소리 끄기" : "🔈 소리 켜기";
});

// ---------- connect ----------

const events = new EventSource("/events");
events.onmessage = (e) => applySnapshot(JSON.parse(e.data));
events.onerror = () => {
  $("source").textContent = "재연결 중";
  $("source").className = "badge";
};

requestAnimationFrame(frame);
