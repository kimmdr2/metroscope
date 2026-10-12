// metroscope client: every Seoul-area line on a real 3D map, trains gliding along the actual
// track, headway gaps colored, station boards, and the sound of the train you're following.

import * as maplibregl from "./vendor/maplibre-gl/maplibre-gl.mjs";
import { applyPalette, baseStyle, paletteFor } from "./basemap.js";
import { dist, distOfPos, posOfDist, pointAt, prepareChain, ribbon, slice, wrapDist } from "./geo.js";
import { followSound, setSound, stopAll } from "./sound.js";

const $ = (id) => document.getElementById(id);
const mobile = matchMedia("(max-width: 720px)").matches;
const coarse = matchMedia("(pointer: coarse)").matches;

const HOME = { center: [126.985, 37.548], zoom: mobile ? 9.7 : 10.7, pitch: 52, bearing: -17 };
// Live data arrives every ~75s; between updates moving trains advance at a typical speed (or the
// speed implied by the feed's arrival countdown), but never past the next station.
const RUN_SPEED = 11; // m/s
// Train bodies, in meters. Width and height are exaggerated so they read at city zoom.
const TRAIN = { length: 170, width: 34, height: 40 };
const ZOOM_3D = 12.8; // dots hand over to 3D bodies around here
const GAP_COLORS = { bunch: "#5eead4", ok: "#3f8f5c", wide: "#f59e0b", hole: "#ef4444" };
// Trains are re-uploaded to the map at most this often; the map itself still renders every frame.
const TRAIN_FRAME_MS = mobile || coarse ? 50 : 33;
const THEME_KEY = "metroscope:theme";
const MERGE_M = 450;

// ---------- state ----------

/** id -> line, with chains prepared for distance lookups and a display color for the current theme */
const lines = new Map();
/** id -> { line, chain, dir, d (shown, meters), baseD, basePos, v (m/s), moving, dest, express, eta, etaD, ll } */
const trains = new Map();
let stations = [];
let snapshot = null;
let receivedAt = 0;
let stale = false;
let mode = "lines";
let focus = null;
let selected = null;
let following = false;
let tilted = true;
let gaps = [];
let ripples = [];
let map;
let ready = false;
let theme = readPref();
let palette;
let ui;
/** Open station board: { name, lines, line, data } */
let board = null;
/** The follow cam waits until camera animations we started (zoom-in, 2D/3D switch) are done. */
let cameraBusyUntil = 0;
/** True while the user is dragging/zooming/rotating the map. */
let userMoving = false;
function ease(opts) {
  cameraBusyUntil = performance.now() + (opts.duration ?? 1000) + 50;
  map.easeTo(opts);
}

function readPref() {
  try {
    return localStorage.getItem(THEME_KEY) ?? "auto";
  } catch {
    return "auto";
  }
}
function savePref(v) {
  try {
    localStorage.setItem(THEME_KEY, v);
  } catch {}
}

// ---------- helpers ----------

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgbToHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** Official line colors, nudged so they read on the map: very dark ones lifted at night, very light ones deepened by day. */
function lineColor(hex, theme) {
  const L = luminance(hex);
  if (theme === "dark" && L < 0.12) return rgbToHex(hexToRgb(hex).map((c) => c + (255 - c) * 0.32));
  if (theme === "light" && L > 0.42) return rgbToHex(hexToRgb(hex).map((c) => c * 0.8));
  return hex;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const badgeHtml = (line) =>
  `<span class="line-badge${luminance(line.color) > 0.4 ? " dark-text" : ""}" style="--c:${line.color}">${esc(line.short)}</span>`;

const kst = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const kstDate = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "long", day: "numeric", weekday: "short" });

const chainOf = (t) => lines.get(t.line).chains[t.chain];
const stationName = (c, pos) => c.stations[Math.round(pos) % c.n];

// ---------- network ----------

async function loadNetwork() {
  const net = await (await fetch(new URL("network.json", import.meta.url))).json();
  for (const l of net.lines) lines.set(l.id, { ...l, chains: l.chains.map(prepareChain) });

  // Same-named stops on different lines are one station only when they're close: 서울역's
  // platforms span ~500m, but 신촌 on 2호선 and on 경의중앙선 are 630m apart and separate stations.
  // Clusters chain through near neighbors; each line keeps its own dot on its own track.
  const dots = [];
  for (const l of lines.values()) for (const [name, ll] of Object.entries(l.stations)) dots.push({ name, line: l.id, ll });
  const parent = dots.map((_, i) => i);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let i = 0; i < dots.length; i++) {
    for (let j = i + 1; j < dots.length; j++) {
      if (dots[i].name === dots[j].name && dist(dots[i].ll, dots[j].ll) < MERGE_M) parent[root(i)] = root(j);
    }
  }
  const clusters = new Map();
  for (let i = 0; i < dots.length; i++) {
    if (!clusters.has(root(i))) clusters.set(root(i), []);
    clusters.get(root(i)).push(dots[i]);
  }
  stations = [...clusters.values()].map((members) => {
    // The label sits on a real dot (the one nearest the middle), never in the empty space between.
    const mid = [members.reduce((a, m) => a + m.ll[0], 0) / members.length, members.reduce((a, m) => a + m.ll[1], 0) / members.length];
    const anchor = members.reduce((b, m) => (dist(m.ll, mid) < dist(b.ll, mid) ? m : b));
    return { name: anchor.name, ll: anchor.ll, lines: [...new Set(members.map((m) => m.line))], dots: members };
  });
}

/**
 * One feature per station-to-station leg. Where two lines share a leg (경의중앙·경춘 회기~상봉,
 * 서해·경의중앙 일산~대곡, 4호선·수인분당 안산~오이도…) they're drawn side by side via an offset.
 */
function legFeatures() {
  const lineList = [...lines.values()];
  const legs = [];
  lineList.forEach((l, li) =>
    l.chains.forEach((c) => {
      const count = c.loop ? c.n : c.n - 1;
      for (let i = 0; i < count; i++) {
        const end = c.loop && i === c.n - 1 ? c.path.length - 1 : c.at[i + 1];
        const coords = c.path.slice(c.at[i], end + 1);
        legs.push({ line: l.id, z: lineList.length - li, a: c.stations[i], b: c.stations[(i + 1) % c.n], coords, mid: coords[coords.length >> 1], o: 0 });
      }
    }),
  );
  const groups = new Map();
  for (const g of legs) {
    const key = [g.a, g.b].sort().join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(g);
  }
  for (const [key, group] of groups) {
    const near = group.filter((g) => dist(g.mid, group[0].mid) < 250);
    const ids = [...new Set(near.map((g) => g.line))];
    if (ids.length < 2) continue;
    const first = key.split("|")[0];
    for (const g of near) {
      const o = ids.indexOf(g.line) - (ids.length - 1) / 2;
      g.o = g.a === first ? o : -o; // offsets are relative to drawing direction
    }
  }
  return legs.map((g) => {
    const l = lines.get(g.line);
    return {
      type: "Feature",
      properties: { line: g.line, z: g.z, o: g.o, cd: lineColor(l.color, "dark"), cl: lineColor(l.color, "light") },
      geometry: { type: "LineString", coordinates: g.coords },
    };
  });
}

// ---------- map ----------

/**
 * The train marker: a navigation-style arrowhead pointing up (north), as a signed distance field
 * so it can be tinted per line and outlined with a halo. Same encoding as MapLibre's glyphs.
 */
function arrowImage() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.beginPath();
  ctx.moveTo(32, 7); // nose
  ctx.lineTo(51, 55);
  ctx.lineTo(32, 44); // notch in the tail
  ctx.lineTo(13, 55);
  ctx.closePath();
  ctx.lineJoin = "round";
  ctx.lineWidth = 4;
  ctx.fill();
  ctx.stroke(); // rounds the corners a little
  const alpha = ctx.getImageData(0, 0, size, size).data;
  const inside = (x, y) => alpha[(y * size + x) * 4 + 3] > 127;
  const edges = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = inside(x, y);
      if ((x > 0 && inside(x - 1, y) !== v) || (y > 0 && inside(x, y - 1) !== v)) edges.push([x, y]);
    }
  }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let best = Infinity;
      for (const [ex, ey] of edges) best = Math.min(best, (ex - x) ** 2 + (ey - y) ** 2);
      const d = Math.sqrt(best) * (inside(x, y) ? -1 : 1);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.max(0, Math.min(255, 255 - 255 * (d / 8 + 0.25)));
    }
  }
  return { width: size, height: size, data };
}

function createMap() {
  map = new maplibregl.Map({
    container: "map",
    style: baseStyle(palette),
    center: HOME.center,
    zoom: HOME.zoom - 0.6,
    pitch: 0,
    bearing: 0,
    maxPitch: 72,
    maxBounds: [[125.6, 36.4], [128.4, 38.5]],
    attributionControl: { compact: true },
    // Hangul is drawn with a system font: every OS ships one, and it saves megabytes of glyph PBFs.
    localIdeographFontFamily: "'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans CJK KR', 'Noto Sans KR', sans-serif",
    fadeDuration: 200,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  // Keep the city centered in the part of the screen the bottom sheet doesn't cover.
  if (mobile) map.setPadding({ top: 0, bottom: 170, left: 0, right: 0 });

  map.on("load", () => {
    addLayers();
    ready = true;
    applyTheme();
    $("loading").classList.add("done");
    // Tilt into the city.
    ease({ ...HOME, duration: 2800, easing: (t) => 1 - (1 - t) ** 3 });
  });

  // Moving the map by hand only pauses the chase cam; following ends with its button alone.
  map.on("movestart", (e) => e.originalEvent && (userMoving = true));
  map.on("moveend", () => {
    if (!userMoving) return;
    userMoving = false;
    cameraBusyUntil = Math.max(cameraBusyUntil, performance.now() + 800);
  });
  map.on("mousemove", onHover);
  map.on("mouseout", () => tip.remove());
  map.on("click", onClick);
}

const empty = () => ({ type: "FeatureCollection", features: [] });
const fc = (features) => ({ type: "FeatureCollection", features });
// Zoom curves must be the top-level expression, so variants are built from the stops.
const byZoom = (stops, f = (v) => v) => ["interpolate", ["exponential", 1.5], ["zoom"], ...stops.flatMap(([z, v]) => [z, f(v)])];
const WIDTHS = [[8, 1.2], [11, 2.6], [14, 5], [17, 10]];
// Shared legs sit one line-width (plus a hair) apart.
const OFFSET = byZoom(WIDTHS, (v) => ["*", ["get", "o"], v + 1]);

function addLayers() {
  map.addSource("lines", { type: "geojson", data: fc(legFeatures()) });
  // A dot per line at each station (on that line's track), a label per station.
  map.addSource("stations", {
    type: "geojson",
    data: fc(stations.flatMap((s) => s.dots.map((d) => ({
      type: "Feature",
      properties: {
        name: s.name,
        line: d.line,
        lines: `,${s.lines.join(",")},`,
        transfer: s.lines.length > 1,
        cd: lineColor(lines.get(d.line).color, "dark"),
        cl: lineColor(lines.get(d.line).color, "light"),
      },
      geometry: { type: "Point", coordinates: d.ll },
    })))),
  });
  map.addSource("station-labels", {
    type: "geojson",
    data: fc(stations.map((s) => ({
      type: "Feature",
      properties: { name: s.name, lines: `,${s.lines.join(",")},`, transfer: s.lines.length > 1 },
      geometry: { type: "Point", coordinates: s.ll },
    }))),
  });
  for (const id of ["gaps", "ripples", "trails", "trains", "trains3d"]) map.addSource(id, { type: "geojson", data: empty() });
  map.addImage("train-arrow", arrowImage(), { sdf: true, pixelRatio: 2 });

  const lineLayout = { "line-join": "round", "line-cap": "round", "line-sort-key": ["get", "z"] };
  map.addLayer({
    id: "line-glow", type: "line", source: "lines", layout: lineLayout,
    paint: {
      "line-width": ["interpolate", ["linear"], ["zoom"], 8, 5, 12, 12, 16, 28],
      "line-blur": ["interpolate", ["linear"], ["zoom"], 8, 4, 16, 16],
      "line-offset": OFFSET,
    },
  });
  map.addLayer({
    id: "line-casing", type: "line", source: "lines", layout: lineLayout,
    paint: { "line-width": byZoom(WIDTHS, (v) => v + 2.5), "line-offset": OFFSET },
  });
  map.addLayer({
    id: "line-core", type: "line", source: "lines", layout: lineLayout,
    paint: { "line-width": byZoom(WIDTHS), "line-offset": OFFSET },
  });
  map.addLayer({
    id: "gaps", type: "line", source: "gaps",
    layout: { "line-join": "round", "line-cap": "round", visibility: "none" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": byZoom([[8, 1.6], [11, 3], [14, 6], [17, 11]]),
      "line-offset": byZoom([[8, 1.2], [11, 2.4], [14, 5], [17, 9]], (v) => ["*", ["get", "dir"], v]),
    },
  });
  map.addLayer({
    id: "station-dot", type: "circle", source: "stations", minzoom: 8.5,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, ["case", ["get", "transfer"], 2.6, 1.4], 12, ["case", ["get", "transfer"], 5, 3], 15, ["case", ["get", "transfer"], 8, 5.5]],
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 9, 0.8, 14, 2],
      "circle-pitch-alignment": "map",
    },
  });
  map.addLayer({
    id: "ripples", type: "circle", source: "ripples",
    paint: {
      "circle-radius": ["get", "r"],
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": ["get", "color"],
      "circle-stroke-width": 1.6,
      "circle-stroke-opacity": ["get", "o"],
      "circle-pitch-alignment": "map",
    },
  });
  // Fading tail behind each moving train, along the track: shows which way it's going at a glance.
  // Wider than the line itself, so it reads as a fading band over a track of the same color.
  map.addLayer({
    id: "train-trail", type: "line", source: "trails",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": byZoom(WIDTHS, (v) => v * 2.6 + 2),
      "line-blur": byZoom(WIDTHS, (v) => v * 0.6),
      // Same side as the arrow (right of travel); drawn in chain order, so flip for dir -1.
      "line-offset": byZoom(WIDTHS, (v) => ["*", ["get", "dir"], v * 0.8 + 2]),
    },
  });
  map.addLayer({
    id: "train-glow", type: "circle", source: "trains", maxzoom: ZOOM_3D + 1,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 8, 12, 18],
      "circle-blur": 1,
      "circle-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.4, ZOOM_3D, 0.35, ZOOM_3D + 1, 0],
      "circle-pitch-alignment": "map",
    },
  });
  // Trains: arrows pointing the way they travel, outlined so they stand out from their own line.
  map.addLayer({
    id: "train-arrow", type: "symbol", source: "trains",
    layout: {
      "icon-image": "train-arrow",
      "icon-size": ["interpolate", ["linear"], ["zoom"], 8, ["case", ["get", "express"], 0.4, 0.34], 10.5, ["case", ["get", "express"], 0.5, 0.42], 12, ["case", ["get", "express"], 0.7, 0.6], ZOOM_3D, ["case", ["get", "express"], 0.9, 0.78], 17, ["case", ["get", "express"], 1.4, 1.25]],
      "icon-rotate": ["get", "bearing"],
      // Each arrow keeps to the right of its direction of travel, so two trains passing at a
      // station sit side by side instead of piling into one shape.
      "icon-offset": [9, 0],
      "icon-rotation-alignment": "map",
      // Upright toward the camera: lying flat, arrows all but vanish in a tilted 3D view.
      "icon-pitch-alignment": "viewport",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "symbol-sort-key": ["get", "z"],
    },
    paint: {
      "icon-halo-width": ["case", ["get", "express"], 2.4, 1.6],
      // Stays on above the 3D bodies when zoomed in, so the direction never disappears.
    },
  });
  map.addLayer({
    id: "train-3d", type: "fill-extrusion", source: "trains3d", minzoom: ZOOM_3D - 0.4,
    paint: {
      "fill-extrusion-height": ["get", "h"],
      "fill-extrusion-base": 0,
      "fill-extrusion-opacity": ["interpolate", ["linear"], ["zoom"], ZOOM_3D - 0.4, 0, ZOOM_3D + 0.4, 1],
      // Flat, full-strength color: the shaded gradient made trains as dark as the buildings.
      "fill-extrusion-vertical-gradient": false,
    },
  });
  map.addLayer({
    id: "train-selected", type: "circle", source: "trains",
    filter: ["==", ["get", "id"], ""],
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 10, 15, 26],
      "circle-color": "rgba(0,0,0,0)",
      "circle-stroke-color": "#14b8a6",
      "circle-stroke-width": 2,
      "circle-pitch-alignment": "map",
    },
  });
  const label = (minzoom, filter, size) => ({
    type: "symbol", source: "station-labels", minzoom, filter,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Noto Sans Regular"],
      "text-size": size,
      "text-variable-anchor": ["top", "bottom", "right", "left"],
      "text-radial-offset": 0.75,
      "text-justify": "auto",
      "text-padding": 3,
    },
    paint: { "text-halo-width": 1.4 },
  });
  map.addLayer({ id: "label-transfer", ...label(10.4, ["get", "transfer"], ["interpolate", ["linear"], ["zoom"], 10, 10.5, 14, 13.5, 17, 16]) });
  map.addLayer({ id: "label-station", ...label(12.3, ["!", ["get", "transfer"]], ["interpolate", ["linear"], ["zoom"], 12, 10, 14, 12.5, 17, 15]) });
}

// ---------- theme ----------

/** Recolors map and panels for the chosen theme; in "auto" it's re-run every minute to follow the sun. */
function applyTheme() {
  const next = paletteFor(theme);
  palette = next.palette;
  ui = next.ui;
  document.documentElement.dataset.theme = ui;
  document.querySelector('meta[name="theme-color"]').content = palette.bg;
  for (const l of lines.values()) l.display = lineColor(l.color, ui);
  for (const b of document.querySelectorAll("[data-theme-choice]")) b.setAttribute("aria-checked", String(b.dataset.themeChoice === theme));
  if (!ready) return;
  applyPalette(map, palette);
  const key = ["get", ui === "light" ? "cl" : "cd"];
  map.setPaintProperty("line-casing", "line-color", palette.bg);
  map.setPaintProperty("station-dot", "circle-color", ["case", ["get", "transfer"], "#f4f7fa", palette.bg]);
  map.setPaintProperty("station-dot", "circle-stroke-color", ["case", ["get", "transfer"], ui === "light" ? "#2b333d" : "#0b0f14", key]);
  for (const id of ["label-transfer", "label-station"]) {
    map.setPaintProperty(id, "text-color", palette.text);
    map.setPaintProperty(id, "text-halo-color", palette.bg);
  }
  applyFocus();
}

function setTheme(choice) {
  theme = choice;
  savePref(choice);
  applyTheme();
}

// ---------- focus & mode ----------

function applyFocus() {
  if (!ready) return;
  const on = (expr, a, b) => (focus ? ["case", expr, a, b] : a);
  const isLine = ["==", ["get", "line"], focus ?? ""];
  const hasLine = ["in", `,${focus},`, ["get", "lines"]];
  const key = ["get", ui === "light" ? "cl" : "cd"];
  const dimLines = mode === "gaps";
  map.setPaintProperty("line-core", "line-color", key);
  map.setPaintProperty("line-glow", "line-color", key);
  map.setPaintProperty("line-core", "line-opacity", on(isLine, dimLines ? 0.22 : 1, 0.12));
  map.setPaintProperty("line-glow", "line-opacity", on(isLine, dimLines ? 0.05 : palette.glow, 0.03));
  map.setPaintProperty("line-casing", "line-opacity", on(isLine, 0.85, 0.3));
  map.setPaintProperty("station-dot", "circle-opacity", on(isLine, 1, 0.25));
  map.setPaintProperty("station-dot", "circle-stroke-opacity", on(isLine, 1, 0.25));
  map.setPaintProperty("train-arrow", "icon-color", on(isLine, ["get", "color"], palette.dim));
  map.setPaintProperty("train-arrow", "icon-halo-color", on(isLine, "#ffffff", "rgba(255,255,255,0.15)"));
  // A colored glow reads on the dark map; on the light map a soft shadow lifts the train instead.
  map.setPaintProperty("train-glow", "circle-color", on(isLine, ui === "light" ? "rgba(20,28,40,0.35)" : ["get", "color"], "rgba(0,0,0,0)"));
  map.setPaintProperty("train-trail", "line-opacity", on(isLine, ["get", "o"], 0));
  map.setPaintProperty("train-3d", "fill-extrusion-color", on(isLine, ["get", "color"], palette.dim));
  map.setLayoutProperty("gaps", "visibility", mode === "gaps" ? "visible" : "none");
  map.setPaintProperty("gaps", "line-opacity", on(isLine, 1, 0.08));
  for (const id of ["label-transfer", "label-station"]) map.setPaintProperty(id, "text-opacity", on(hasLine, 1, 0.3));
}

function setFocus(id, fly = true) {
  focus = focus === id ? null : id;
  for (const b of document.querySelectorAll("#lines button")) b.setAttribute("aria-pressed", String(b.dataset.line === focus));
  $("lines").classList.toggle("focused", !!focus);
  $("clear-focus").hidden = !focus;
  applyFocus();
  updateStats();
  if (focus && fly) fitTo(lines.get(focus).chains.flatMap((c) => c.path));
}

function fitTo(coords, maxZoom = 13.5) {
  const b = new maplibregl.LngLatBounds();
  for (const p of coords) b.extend(p);
  const pad = mobile ? { top: 60, bottom: 200, left: 30, right: 30 } : { top: 70, bottom: 70, left: 370, right: 80 };
  cameraBusyUntil = performance.now() + 1650;
  map.fitBounds(b, { padding: pad, maxZoom, pitch: tilted ? 45 : 0, bearing: tilted ? map.getBearing() : 0, duration: 1600 });
}

function setMode(m) {
  mode = m;
  for (const b of document.querySelectorAll("[data-mode]")) b.setAttribute("aria-checked", String(b.dataset.mode === m));
  $("legend").hidden = m !== "gaps";
  computeGaps();
  applyFocus();
}

// ---------- snapshots ----------

/** Meters from `d` to station index `idx`, going in direction `dir` (wrapping on loops). */
function forward(c, d, idx, dir) {
  let m = (c.stationD[idx] - d) * dir;
  if (c.loop) m = ((m % c.total) + c.total) % c.total;
  return m;
}

function applySnapshot(snap) {
  const now = performance.now();
  const dtSnap = snapshot ? (now - receivedAt) / 1000 : 0;
  snapshot = snap;
  receivedAt = now;
  stale = false;
  updateBadge();

  const seen = new Set();
  for (const s of snap.trains) {
    const line = lines.get(s.line);
    const c = line?.chains[s.chain];
    if (!c) continue;
    seen.add(s.id);
    const baseD = distOfPos(c, s.pos);
    let t = trains.get(s.id);
    if (!t || t.line !== s.line || t.chain !== s.chain) {
      t = { id: s.id, line: s.line, chain: s.chain, d: baseD, v: 0, moving: s.moving };
      trains.set(s.id, t);
    } else if (snap.source === "mock" && dtSnap > 0) {
      // Simulation updates every second: carry the measured speed between frames.
      let moved = baseD - t.baseD;
      if (c.loop) moved = ((moved % c.total) + c.total * 1.5) % c.total - c.total / 2;
      t.v = s.moving && Math.abs(moved) < 2000 ? moved / dtSnap : 0;
    }
    if (s.id === selected && !t.moving && s.moving) t.departed = true;
    t.baseD = baseD;
    t.basePos = s.pos;
    t.dir = s.dir;
    t.moving = s.moving;
    t.dest = s.dest;
    t.express = !!s.express;
    t.eta = undefined;
    if (snap.source === "live") {
      t.v = s.moving ? s.dir * RUN_SPEED : 0;
      // Arrival countdown → the speed that gets the train there on time, if it's plausible.
      if (s.eta && s.moving) {
        const meters = forward(c, baseD, s.eta.station, s.dir);
        const secs = (s.eta.at - snap.ts) / 1000;
        if (secs > 5 && meters / secs > 2 && meters / secs < 30) {
          t.eta = s.eta;
          t.etaD = meters;
        }
      }
    }
  }
  for (const id of trains.keys()) if (!seen.has(id)) trains.delete(id);
  if (selected && !trains.has(selected)) selectTrain(null, true);

  // Live arrivals were collected over the whole polling interval; spread them back out.
  for (const a of snap.arrivals) setTimeout(() => onArrival(a), Math.random() * snap.intervalMs * (snap.source === "live" ? 0.85 : 1));

  updateLineList();
  computeGaps();
}

function updateBadge() {
  const badge = $("source");
  if (!snapshot) return;
  if (snapshot.paused) {
    badge.textContent = "운행 종료";
    badge.className = "badge paused";
  } else if (stale) {
    badge.textContent = "지연";
    badge.className = "badge stale";
  } else {
    badge.textContent = snapshot.source === "live" ? "LIVE" : "SIMULATION";
    badge.className = `badge ${snapshot.source}`;
  }
}

/** How old the data is; past two polling intervals the badge says so and trains stop extrapolating. */
function updateAge() {
  const el = $("age");
  if (!snapshot || snapshot.paused) {
    el.textContent = "";
    return;
  }
  const age = Math.max(0, Date.now() - snapshot.ts);
  const limit = snapshot.source === "live" ? snapshot.intervalMs * 2 + 20_000 : 10_000;
  const wasStale = stale;
  stale = age > limit;
  if (stale !== wasStale) updateBadge();
  el.classList.toggle("stale", stale);
  if (snapshot.source !== "live") {
    el.textContent = stale ? "시뮬레이션 응답이 없어요" : "";
    return;
  }
  const s = Math.round(age / 1000);
  const ago = s < 60 ? `${s}초 전` : `${Math.floor(s / 60)}분 전`;
  el.textContent = stale ? `${ago} 갱신 · 실시간 데이터가 늦어지고 있어요` : `${ago} 갱신`;
}

// ---------- animation ----------

/** Meters a train may still travel before reaching the next station in its direction. */
function roomAhead(c, t) {
  const pos = t.basePos;
  if (t.dir > 0) {
    const i = Math.floor(pos + 1e-6) + 1;
    return i < c.stationD.length ? c.stationD[i] - t.baseD : 0;
  }
  const i = Math.ceil(pos - 1e-6) - 1;
  if (i < 0) return c.loop ? t.baseD + (c.total - c.stationD[c.n - 1]) : 0;
  return t.baseD - c.stationD[i];
}

let last = performance.now();
let lastTrains = 0;
let lastGaps = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!ready || !snapshot) return;

  const elapsed = (now - receivedAt) / 1000;
  const live = snapshot.source === "live";
  const k = 1 - Math.exp(-dt * 4);
  for (const t of trains.values()) {
    const c = chainOf(t);
    let run = 0;
    if (!stale) {
      if (t.eta) run = t.etaD * Math.min(1, (Date.now() - snapshot.ts) / (t.eta.at - snapshot.ts));
      else run = Math.abs(t.v) * Math.min(elapsed, live ? Infinity : (snapshot.intervalMs / 1000) * 1.5);
    }
    // Never run past the next station: the train will stop there (or the next update says otherwise).
    const ahead = t.dir * Math.min(run, Math.max(0, roomAhead(c, t) - (live ? 15 : 0)));
    const target = t.baseD + ahead;
    let diff = target - t.d;
    if (c.loop) diff = ((diff % c.total) + c.total * 1.5) % c.total - c.total / 2;
    const prev = t.d;
    t.d = Math.abs(diff) > 4000 ? target : t.d + diff * (live ? k : Math.min(1, k * 3));
    t.d = wrapDist(c, t.d);
    if (t.id === selected && dt > 0) t.speed = (t.speed ?? 0) * 0.9 + Math.min(60, Math.abs(t.d - prev) / dt) * 0.1;
    const p = pointAt(c, t.d);
    t.ll = p.lngLat;
    t.bearing = t.dir > 0 ? p.heading : p.heading + 180;
  }

  if (now - lastTrains >= TRAIN_FRAME_MS) {
    lastTrains = now;
    renderTrains();
  }
  renderRipples(now);
  if (now - lastGaps > 300) {
    lastGaps = now;
    computeGaps();
  }
  if (following && selected) {
    const t = trains.get(selected);
    if (t) {
      // Chase-cam, but let camera animations (the zoom-in, 2D/3D switch) finish first.
      if (now > cameraBusyUntil && !userMoving) {
        const c = map.getCenter();
        map.jumpTo({ center: [c.lng + (t.ll[0] - c.lng) * 0.12, c.lat + (t.ll[1] - c.lat) * 0.12] });
      }
      followSound(t.speed ?? 0, soundEvent(t));
    }
  }
}

/** "arrive" once as the followed train closes in on a station, "depart" when it pulls out. */
function soundEvent(t) {
  if (t.departed) {
    t.departed = false;
    return "depart";
  }
  const c = chainOf(t);
  const pos = posOfDist(c, t.d);
  const next = t.dir > 0 ? Math.floor(pos + 0.02) + 1 : Math.ceil(pos - 0.02) - 1;
  const idx = c.loop ? ((next % c.n) + c.n) % c.n : next;
  if (idx < 0 || idx >= c.n || !t.moving) return null;
  if (forward(c, t.d, idx, t.dir) < 160 && t.arrivedAt !== idx) {
    t.arrivedAt = idx;
    return "arrive";
  }
  return null;
}

/** About how many meters one screen pixel covers right now. */
const metersPerPixel = () => (78271.517 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** map.getZoom();

// Tail pieces behind a train: [from, to] as fractions of the tail length, and their opacity.
const TRAIL = [[0, 0.3, 0.55], [0.3, 0.65, 0.3], [0.65, 1, 0.12]];

function renderTrains() {
  const points = [];
  const trails = [];
  // ~45px of tail at any zoom, but never more than 1.5km of track.
  const tail = Math.min(1500, 45 * metersPerPixel());
  const lineOrder = [...lines.keys()];
  for (const t of trains.values()) {
    const color = lines.get(t.line).display;
    points.push({
      type: "Feature",
      properties: { id: t.id, line: t.line, color, express: t.express, bearing: t.bearing, z: lineOrder.length - lineOrder.indexOf(t.line) },
      geometry: { type: "Point", coordinates: t.ll },
    });
    if (!t.moving || stale) continue;
    const c = chainOf(t);
    for (const [a, b, o] of TRAIL) {
      // Behind the train: lower distances when heading up the chain, higher when heading down.
      let d1 = t.dir > 0 ? t.d - tail * b : t.d + tail * a;
      let d2 = t.dir > 0 ? t.d - tail * a : t.d + tail * b;
      if (c.loop) {
        const shift = d1 < 0 ? c.total : d1 >= c.total ? -c.total : 0;
        d1 += shift;
        d2 += shift;
      } else {
        d1 = Math.max(0, d1);
        d2 = Math.min(c.total, d2);
      }
      if (d2 - d1 < 5) continue;
      trails.push({ type: "Feature", properties: { line: t.line, color, o, dir: t.dir }, geometry: { type: "LineString", coordinates: slice(c, d1, d2) } });
    }
  }
  map.getSource("trains").setData(fc(points));
  map.getSource("trails").setData(fc(trails));

  if (map.getZoom() < ZOOM_3D - 0.5) return;
  const bounds = map.getBounds();
  const bodies = [];
  for (const t of trains.values()) {
    if (!bounds.contains(t.ll)) continue;
    const c = chainOf(t);
    let d1 = t.d - TRAIN.length / 2;
    let d2 = t.d + TRAIN.length / 2;
    if (!c.loop) {
      d1 = Math.max(0, d1);
      d2 = Math.min(c.total, d2);
    }
    // Evenly spaced samples rather than raw track vertices, so a kink in the track can't twist the body.
    const centerline = [];
    for (let i = 0; i <= 6; i++) centerline.push(pointAt(c, d1 + ((d2 - d1) * i) / 6).lngLat);
    // Taper the leading end into a nose so the direction shows up close too.
    const nose = (f) => (t.dir > 0 ? f : 1 - f);
    const ring = ribbon(centerline, (f) => TRAIN.width * (nose(f) < 0.8 ? 1 : 1 - ((nose(f) - 0.8) / 0.2) * 0.75));
    if (!ring) continue;
    bodies.push({
      type: "Feature",
      properties: { id: t.id, line: t.line, color: lines.get(t.line).display, h: TRAIN.height },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  }
  map.getSource("trains3d").setData(fc(bodies));
}

// ---------- headway gaps ----------

function gapColor(stationsApart) {
  if (stationsApart < 1) return GAP_COLORS.bunch;
  if (stationsApart >= 6) return GAP_COLORS.hole;
  if (stationsApart >= 4) return GAP_COLORS.wide;
  return GAP_COLORS.ok;
}

/** Like posOfDist, but distances past the end of a loop keep counting up instead of wrapping. */
const posAlong = (c, d) => (c.loop && d >= c.total ? posOfDist(c, d - c.total) + c.n : posOfDist(c, d));

function computeGaps() {
  if (!ready) return;
  const groups = new Map();
  for (const t of trains.values()) {
    const key = `${t.line}|${t.chain}|${t.dir}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  gaps = [];
  for (const [key, list] of groups) {
    const [lineId, chainIdx, dir] = key.split("|");
    const c = lines.get(lineId).chains[+chainIdx];
    list.sort((a, b) => a.d - b.d);
    const pairs = list.length - (c.loop ? 0 : 1);
    for (let i = 0; i < pairs; i++) {
      const a = list[i];
      const b = list[(i + 1) % list.length];
      let d2 = b.d;
      if (c.loop && i === list.length - 1) d2 += c.total; // last train back around to the first
      if (d2 - a.d < 30) continue;
      gaps.push({ line: lineId, chain: c, dir: +dir, from: a.d, to: d2, span: posAlong(c, d2) - posAlong(c, a.d) });
    }
  }
  if (mode === "gaps") {
    map.getSource("gaps").setData(fc(gaps.map((g) => ({
      type: "Feature",
      properties: { line: g.line, dir: g.dir, color: gapColor(g.span) },
      geometry: { type: "LineString", coordinates: slice(g.chain, g.from, g.to) },
    }))));
  }
  updateStats();
}

let maxGap = null;
function updateStats() {
  const ts = focus ? [...trains.values()].filter((t) => t.line === focus) : [...trains.values()];
  $("stat-trains").textContent = snapshot ? ts.length.toLocaleString("ko-KR") : "–";
  const gs = focus ? gaps.filter((g) => g.line === focus) : gaps;
  const btn = $("stat-max");
  if (snapshot?.paused) {
    $("stat-avg").textContent = "–";
    btn.textContent = "01:00–05:30 운행 종료";
    btn.disabled = true;
    return;
  }
  if (!gs.length) {
    $("stat-avg").textContent = "–";
    btn.textContent = "–";
    btn.disabled = true;
    return;
  }
  const avg = gs.reduce((s, g) => s + g.span, 0) / gs.length;
  $("stat-avg").textContent = `${avg.toFixed(1)}역`;
  maxGap = gs.reduce((m, g) => (g.span > m.span ? g : m));
  const line = lines.get(maxGap.line);
  const c = maxGap.chain;
  const from = stationName(c, posOfDist(c, maxGap.from));
  const to = stationName(c, posOfDist(c, maxGap.to));
  btn.innerHTML = `${badgeHtml(line)} ${esc(from)} ↔ ${esc(to)} <span class="muted">${maxGap.span.toFixed(1)}역</span>`;
  btn.disabled = false;
}

// ---------- arrivals ----------

function onArrival(a) {
  if (!ready) return;
  const line = lines.get(a.line);
  const c = line?.chains[a.chain];
  if (!c) return;
  const ll = c.path[c.at[a.station]];
  if (!ll || !map.getBounds().contains(ll)) return;
  if (focus && focus !== a.line) return;
  if (ripples.length < 80) ripples.push({ ll, color: line.display, t0: performance.now() });
}

let ripplesShown = false;
function renderRipples(now) {
  if (!ripples.length && !ripplesShown) return;
  ripples = ripples.filter((r) => now - r.t0 < 1600);
  ripplesShown = ripples.length > 0;
  const z = map.getZoom();
  const scale = Math.max(0.6, Math.min(2, (z - 8) / 4));
  map.getSource("ripples").setData(fc(ripples.map((r) => {
    const p = (now - r.t0) / 1600;
    const e = 1 - (1 - p) ** 3;
    return {
      type: "Feature",
      properties: { color: r.color, r: (4 + e * 20) * scale, o: 0.9 * (1 - p) },
      geometry: { type: "Point", coordinates: r.ll },
    };
  })));
}

// ---------- interaction ----------

const tip = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "tip", offset: 14, maxWidth: "260px" });

function trainAt(point) {
  const box = [[point.x - 8, point.y - 8], [point.x + 8, point.y + 8]];
  const hit = map.queryRenderedFeatures(box, { layers: ["train-3d", "train-arrow"] })[0];
  return hit && trains.get(hit.properties.id);
}
function stationAt(point) {
  const box = [[point.x - 6, point.y - 6], [point.x + 6, point.y + 6]];
  return map.queryRenderedFeatures(box, { layers: ["station-dot", "label-transfer", "label-station"] })[0];
}

function trainSummary(t) {
  const line = lines.get(t.line);
  const c = chainOf(t);
  const pos = posOfDist(c, t.d);
  const at = Math.abs(pos - Math.round(pos)) < 0.12;
  const next = t.dir > 0 ? Math.floor(pos + 0.12) + 1 : Math.ceil(pos - 0.12) - 1;
  const nextName = c.loop ? c.stations[((next % c.n) + c.n) % c.n] : c.stations[next];
  const where = !t.moving && at ? `${stationName(c, pos)} 정차 중` : nextName ? `${nextName} 방면 운행 중` : `${stationName(c, pos)} 부근`;
  const no = t.id.split(":")[1];
  return { line, no, where, dest: t.dest ? `${t.dest}행` : "", express: t.express ? "급행" : "" };
}

function onHover(e) {
  if (!ready) return;
  const t = trainAt(e.point);
  const s = !t && stationAt(e.point);
  map.getCanvas().style.cursor = t || s ? "pointer" : "";
  if (t) {
    const { line, no, where, dest, express } = trainSummary(t);
    tip.setLngLat(t.ll).setHTML(`${badgeHtml(line)} <strong>${esc(line.name)}</strong> <span class="muted">${esc(no)}</span><br>${esc([dest, express].filter(Boolean).join(" · "))}<br><span class="muted">${esc(where)}</span>`).addTo(map);
  } else if (s) {
    const ids = s.properties.lines.split(",").filter(Boolean);
    tip.setLngLat(s.geometry.coordinates).setHTML(`<strong>${esc(s.properties.name)}</strong><div class="badges">${ids.map((id) => badgeHtml(lines.get(id))).join("")}</div>`).addTo(map);
  } else tip.remove();
}

function onClick(e) {
  // On touch screens the hover tooltip would otherwise stay up after a tap.
  if (coarse) tip.remove();
  const t = !following && trainAt(e.point);
  if (t) {
    selectTrain(t.id);
    return;
  }
  const s = stationAt(e.point);
  if (s) {
    openBoard(s.properties.name, s.properties.lines.split(",").filter(Boolean));
    // While following, the camera stays on the train; the board still opens.
    if (!following) ease({ center: s.geometry.coordinates, zoom: Math.max(map.getZoom(), 14.5), duration: 1200 });
    return;
  }
  closeBoard();
  if (!following) selectTrain(null);
}

/** Selects a train (or none). While following, only `force` (the train left service) changes it. */
function selectTrain(id, force = false) {
  if (following && !force && id !== selected) return;
  selected = id;
  if (!id) setFollow(false);
  else closeBoard();
  if (ready) map.setFilter("train-selected", ["==", ["get", "id"], id ?? ""]);
  $("train-card").hidden = !id;
  updateTrainCard();
}

function updateTrainCard() {
  const t = selected && trains.get(selected);
  if (!t) return;
  const { line, no, where, dest, express } = trainSummary(t);
  const badge = $("tc-badge");
  badge.textContent = line.short;
  badge.style.setProperty("--c", line.color);
  badge.classList.toggle("dark-text", luminance(line.color) > 0.4);
  $("tc-title").textContent = `${line.name} ${dest}`;
  $("tc-sub").textContent = [`열차 ${no}`, express].filter(Boolean).join(" · ");
  $("tc-status").textContent = where;
}

function setFollow(on) {
  following = on && !!selected;
  $("tc-follow").setAttribute("aria-pressed", String(following));
  $("tc-follow").textContent = following ? "따라가기 취소" : "따라가기";
  // The card can't be closed mid-follow: the cancel button is the way out.
  $("tc-close").hidden = following;
  if (following) {
    const t = trains.get(selected);
    t.arrivedAt = undefined;
    ease({ center: t.ll, zoom: Math.max(map.getZoom(), 14.6), pitch: tilted ? 62 : 0, duration: 1400 });
  } else stopAll();
}

// ---------- station board ----------

function openBoard(name, lineIds) {
  if (!following) selectTrain(null);
  board = { name, lines: lineIds, line: focus && lineIds.includes(focus) ? focus : lineIds[0], data: undefined };
  $("sc-title").textContent = name;
  $("sc-lines").innerHTML = lineIds
    .map((id) => `<button type="button" role="tab" data-line="${esc(id)}" aria-selected="${id === board.line}" title="${esc(lines.get(id).name)}">${badgeHtml(lines.get(id))}</button>`)
    .join("");
  $("station-card").hidden = false;
  fetchBoard();
}

function closeBoard() {
  board = null;
  $("station-card").hidden = true;
}

async function fetchBoard() {
  const b = board;
  if (!b) return;
  renderBoard();
  let data = null;
  try {
    const res = await fetch(`/api/board?line=${encodeURIComponent(b.line)}&station=${encodeURIComponent(b.name)}`);
    if (res.ok) data = await res.json();
  } catch {}
  if (board !== b) return;
  b.data = data;
  renderBoard();
}

function when(item) {
  if (item.at) {
    const s = Math.round((item.at - Date.now()) / 1000);
    if (s > -30) {
      if (s <= 20) return { text: "곧 도착", far: false };
      if (s < 60) return { text: `${s}초`, far: false };
      return { text: `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, "0")}초`, far: false };
    }
  }
  return { text: item.msg.replace(/\s*\(.*\)$/, ""), far: true };
}

function renderBoard() {
  if (!board) return;
  const el = $("sc-board");
  if (board.data === undefined) {
    el.innerHTML = `<p class="empty">불러오는 중…</p>`;
    return;
  }
  const covered = snapshot?.source !== "live" || snapshot.lines.includes(board.line);
  if (!board.data?.groups?.length) {
    el.innerHTML = `<p class="empty">${covered ? "다가오는 열차 정보가 없어요" : "이 노선은 실시간 정보를 제공하지 않아요"}</p>`;
    return;
  }
  el.innerHTML = board.data.groups
    .map((g) => `<section><h3>${esc(g.heading)}</h3><ol>${g.items
      .map((i) => {
        const w = when(i);
        return `<li><button type="button" data-train="${esc(i.train)}"><span>${esc(i.dest ? `${i.dest}행` : "열차")}${i.express ? '<span class="exp">급행</span>' : ""}</span><span class="when${w.far ? " far" : ""}">${esc(w.text)}</span></button></li>`;
      })
      .join("")}</ol></section>`)
    .join("");
}

// ---------- panel ----------

function buildLineList() {
  const ul = $("lines");
  ul.replaceChildren();
  for (const l of lines.values()) {
    const li = document.createElement("li");
    li.innerHTML = `<button type="button" data-line="${esc(l.id)}" aria-pressed="false">${badgeHtml(l)}<span>${esc(l.name)}</span><span class="count">–</span></button>`;
    li.firstChild.addEventListener("click", () => setFocus(l.id));
    ul.appendChild(li);
  }
}

function updateLineList() {
  const counts = new Map();
  for (const t of trains.values()) counts.set(t.line, (counts.get(t.line) ?? 0) + 1);
  const covered = new Set(snapshot?.lines ?? []);
  for (const b of document.querySelectorAll("#lines button")) {
    const id = b.dataset.line;
    const nolive = snapshot?.source === "live" && !snapshot.paused && !covered.has(id);
    b.classList.toggle("nolive", nolive);
    b.querySelector(".count").textContent = nolive ? "실시간 미제공" : String(counts.get(id) ?? 0);
  }
}

function setTilt(on) {
  tilted = on;
  $("tilt").setAttribute("aria-pressed", String(on));
  map.setLayoutProperty("buildings", "visibility", on ? "visible" : "none");
  ease({ pitch: on ? HOME.pitch : 0, bearing: on ? HOME.bearing : 0, duration: 1000 });
}

let lastThemeTick = 0;
function tickClock() {
  const d = new Date();
  $("clock").textContent = kst.format(d);
  $("date").textContent = kstDate.format(d);
  updateAge();
  updateTrainCard();
  if (board?.data) renderBoard();
  if (theme === "auto" && Date.now() - lastThemeTick > 60_000) {
    lastThemeTick = Date.now();
    applyTheme();
  }
}

function wireUi() {
  for (const b of document.querySelectorAll("[data-mode]")) b.addEventListener("click", () => setMode(b.dataset.mode));
  for (const b of document.querySelectorAll("[data-theme-choice]")) b.addEventListener("click", () => setTheme(b.dataset.themeChoice));
  $("clear-focus").addEventListener("click", () => setFocus(focus));
  $("stat-max").addEventListener("click", () => maxGap && fitTo(slice(maxGap.chain, maxGap.from, maxGap.to), 14));
  $("home").addEventListener("click", () => {
    const view = { ...HOME, pitch: tilted ? HOME.pitch : 0, bearing: tilted ? HOME.bearing : 0, duration: 1600 };
    // While following, zoom out around the train instead of leaving it.
    ease(following && trains.get(selected) ? { ...view, center: trains.get(selected).ll } : view);
  });
  $("tilt").addEventListener("click", () => setTilt(!tilted));
  $("sound").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const on = btn.getAttribute("aria-pressed") !== "true";
    btn.setAttribute("aria-pressed", String(on));
    await setSound(on);
  });
  $("tc-close").addEventListener("click", () => selectTrain(null));
  $("tc-follow").addEventListener("click", () => setFollow(!following));
  $("sc-close").addEventListener("click", closeBoard);
  $("sc-lines").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-line]");
    if (!b || !board) return;
    board.line = b.dataset.line;
    board.data = undefined;
    for (const x of $("sc-lines").children) x.setAttribute("aria-selected", String(x.dataset.line === board.line));
    fetchBoard();
  });
  $("sc-board").addEventListener("click", (e) => {
    const id = e.target.closest("button[data-train]")?.dataset.train;
    const t = id && trains.get(id);
    if (!t) return;
    selectTrain(id);
    ease({ center: t.ll, zoom: Math.max(map.getZoom(), 14), duration: 1200 });
  });
  // Boards change with every poll; refetch while one is open.
  setInterval(fetchBoard, 20_000);
  $("sheet-handle").addEventListener("click", () => {
    const p = $("panel");
    p.dataset.open = String(p.dataset.open !== "true");
  });
  addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (board) closeBoard();
    else if (selected && !following) selectTrain(null);
    else if (focus) setFocus(focus, false);
  });
}

// ---------- boot ----------

function connect() {
  const events = new EventSource("/events");
  events.onmessage = (e) => applySnapshot(JSON.parse(e.data));
  events.onerror = () => {
    $("source").textContent = "재연결 중";
    $("source").className = "badge";
  };
}

try {
  applyTheme();
  await loadNetwork();
  for (const l of lines.values()) l.display = lineColor(l.color, ui);
  buildLineList();
  wireUi();
  createMap();
  connect();
  tickClock();
  setInterval(tickClock, 1000);
  requestAnimationFrame(frame);
} catch (err) {
  console.error(err);
  $("loading").innerHTML = `지도를 불러오지 못했습니다: ${esc(err.message)}`;
}
