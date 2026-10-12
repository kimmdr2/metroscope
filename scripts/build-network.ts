// Builds data/network.json from OpenStreetMap: station positions and track geometry for every line.
//
//   npm run build:network            # uses scripts/.cache/osm.json if present
//   npm run build:network -- --refresh
//
// Station order comes from OSM route relations (all-stops services only); geometry follows the
// actual track ways between consecutive stations.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LINES, OSM_EXCLUDE, normalizeStation, type LineDef } from "../server/lines.js";
import type { LngLat, Network, NetworkChain, NetworkLine } from "../server/types.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheFile = path.join(root, "scripts", ".cache", "osm.json");
const outFile = path.join(root, "data", "network.json");

const OVERPASS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const BBOX = "36.7,126.3,38.2,127.8";

interface OsmNode { type: "node"; id: number; lat: number; lon: number; tags?: Record<string, string> }
interface OsmWay { type: "way"; id: number; nodes: number[]; geometry: { lat: number; lon: number }[]; tags?: Record<string, string> }
interface OsmMember { type: string; ref: number; role: string }
interface OsmRel { type: "relation"; id: number; members: OsmMember[]; tags: Record<string, string> }
type OsmElement = OsmNode | OsmWay | OsmRel;

// ---------- fetch ----------

async function loadOsm(refresh: boolean): Promise<OsmElement[]> {
  if (!refresh && fs.existsSync(cacheFile)) {
    console.log(`using cached ${path.relative(root, cacheFile)}`);
    return JSON.parse(fs.readFileSync(cacheFile, "utf8")).elements;
  }
  const names = [...new Set(LINES.map((l) => l.osm.source.replace(/^\^/, "").split(/[:(]/)[0].trim()))];
  const query = `[out:json][timeout:300];
rel["type"="route"]["route"~"^(subway|light_rail|train)$"]["name"~"^(${names.join("|")})"](${BBOX})->.r;
.r out body;
way(r.r);
out geom;
node(r.r);
out;`;
  for (let attempt = 0; attempt < 12; attempt++) {
    const url = OVERPASS[attempt % OVERPASS.length];
    try {
      console.log(`overpass: ${url}`);
      const res = await fetch(url, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        headers: { "User-Agent": "metroscope-databuild (github.com/kimmdr2/metroscope)" },
        signal: AbortSignal.timeout(320_000),
      });
      const text = await res.text();
      if (!res.ok || !text.startsWith("{")) throw new Error(`HTTP ${res.status}`);
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, text);
      return JSON.parse(text).elements;
    } catch (err) {
      console.warn(`  failed (${(err as Error).message}), retrying`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
  throw new Error("Overpass unavailable");
}

// ---------- geometry helpers ----------

const R_EARTH = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
function dist(a: LngLat, b: LngLat) {
  const x = rad(b[0] - a[0]) * Math.cos(rad((a[1] + b[1]) / 2));
  const y = rad(b[1] - a[1]);
  return Math.hypot(x, y) * R_EARTH;
}
const pathLength = (p: LngLat[]) => p.slice(1).reduce((s, q, i) => s + dist(p[i], q), 0);

/** Douglas–Peucker in local meters. */
function simplify(points: LngLat[], tolerance: number): LngLat[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const lat0 = rad(points[0][1]);
  const xy = points.map(([lng, lat]) => [rad(lng) * Math.cos(lat0) * R_EARTH, rad(lat) * R_EARTH]);
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    const [x1, y1] = xy[s];
    const [x2, y2] = xy[e];
    const len = Math.hypot(x2 - x1, y2 - y1) || 1e-9;
    let best = -1;
    let bestD = tolerance;
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((x2 - x1) * (y1 - xy[i][1]) - (x1 - xy[i][0]) * (y2 - y1)) / len;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([s, best], [best, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

class MinHeap {
  private items: [number, number][] = [];
  get size() { return this.items.length; }
  push(key: number, value: number) {
    const a = this.items;
    a.push([key, value]);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

// ---------- per line ----------

interface TrackGraph { adj: Map<number, number[]>; coord: Map<number, LngLat> }

function trackGraph(routes: OsmRel[]): TrackGraph {
  const adj = new Map<number, number[]>();
  const coord = new Map<number, LngLat>();
  const wayIds = new Set(routes.flatMap((r) => r.members.filter((m) => m.type === "way" && !m.role.startsWith("platform")).map((m) => m.ref)));
  for (const id of wayIds) {
    const w = ways.get(id);
    if (!w?.geometry) continue;
    w.nodes.forEach((nid, i) => {
      coord.set(nid, [w.geometry[i].lon, w.geometry[i].lat]);
      if (!adj.has(nid)) adj.set(nid, []);
      if (i > 0) {
        adj.get(nid)!.push(w.nodes[i - 1]);
        adj.get(w.nodes[i - 1])!.push(nid);
      }
    });
  }
  return { adj, coord };
}

const warnings: string[] = [];
const warn = (msg: string) => { warnings.push(msg); console.warn(`  ! ${msg}`); };

function buildLine(def: LineDef): NetworkLine {
  const routes = rels.filter((r) => def.osm.test(r.tags.name ?? "") && !OSM_EXCLUDE.test(r.tags.name ?? ""));
  if (!routes.length) throw new Error(`${def.name}: no OSM routes`);

  // Stop nodes in service order, per route.
  const sequences = routes.map((r) =>
    r.members
      .filter((m) => m.type === "node" && m.role.startsWith("stop"))
      .map((m) => nodes.get(m.ref))
      .filter((n): n is OsmNode => !!n),
  );
  const nameOf = (n: OsmNode): string | undefined => {
    const own = n.tags?.name ?? n.tags?.["name:ko"];
    if (own) return normalizeStation(own);
    // Unnamed stop position: borrow the name of the closest named stop (often another line's
    // platform in the same station).
    let best: string | undefined;
    let bestD = 300;
    for (const m of namedStops) {
      const d = dist([n.lon, n.lat], [m.lon, m.lat]);
      if (d < bestD) { bestD = d; best = m.tags!.name ?? m.tags!["name:ko"]; }
    }
    return best && normalizeStation(best);
  };

  // Station graph from consecutive stops.
  const stopNodes = new Map<string, Set<number>>();
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  for (const seq of sequences) {
    let prev: string | undefined;
    for (const n of seq) {
      let name = nameOf(n);
      if (!name) { warn(`${def.name}: unnamed stop node ${n.id} skipped`); continue; }
      if (name === prev) {
        // Same name twice in a row is a mislabeled stop. Take the name of a differently named stop
        // right next to it (the other direction's platform), or drop it.
        const twin = namedStops.find((m) => dist([n.lon, n.lat], [m.lon, m.lat]) < 50 && nameOf(m) !== name);
        if (!twin) continue;
        name = nameOf(twin)!;
      }
      if (!stopNodes.has(name)) stopNodes.set(name, new Set());
      stopNodes.get(name)!.add(n.id);
      if (prev) link(prev, name);
      prev = name;
    }
  }

  const centroid = (name: string): LngLat => {
    const pts = [...stopNodes.get(name)!].map((id) => nodes.get(id)!);
    return [pts.reduce((s, p) => s + p.lon, 0) / pts.length, pts.reduce((s, p) => s + p.lat, 0) / pts.length];
  };
  const stations: Record<string, LngLat> = {};
  for (const name of stopNodes.keys()) stations[name] = centroid(name);

  // Drop edges that skip stations (a stray express pattern): there's a short detour through
  // other stations that's about as long as the direct hop.
  for (const [a, ns] of adj) {
    for (const b of [...ns]) {
      if (a > b) continue;
      const direct = dist(stations[a], stations[b]);
      const best = new Map<string, number>([[a, 0]]);
      let frontier: [string, number][] = [[a, 0]];
      let skip = false;
      for (let hop = 0; hop < 6 && frontier.length && !skip; hop++) {
        const next: [string, number][] = [];
        for (const [u, du] of frontier) {
          for (const v of adj.get(u)!) {
            if (u === a && v === b) continue;
            const dv = du + dist(stations[u], stations[v]);
            if (dv > direct * 1.35) continue;
            if (v === b) { skip = true; break; }
            if (dv < (best.get(v) ?? Infinity)) { best.set(v, dv); next.push([v, dv]); }
          }
          if (skip) break;
        }
        frontier = next;
      }
      if (skip) {
        ns.delete(b);
        adj.get(b)!.delete(a);
      }
    }
  }

  // Track graph from the routes' own ways; the whole network's tracks are the fallback.
  const lineTracks = trackGraph(routes);
  const trackNodesFor = (g: TrackGraph, name: string): number[] => {
    const ids = [...stopNodes.get(name)!].filter((id) => g.adj.has(id));
    if (ids.length) return ids;
    // Stop nodes not on the track ways: snap to the nearest track node.
    const c = stations[name];
    let best: number | undefined;
    let bestD = 120;
    for (const [id, p] of g.coord) {
      const d = dist(c, p);
      if (d < bestD) { bestD = d; best = id; }
    }
    return best === undefined ? [] : [best];
  };

  function trackPath(a: string, b: string): LngLat[] {
    const found = searchTrack(lineTracks, a, b) ?? searchTrack(allTracks, a, b);
    if (found) return found;
    warn(`${def.name}: no track path ${a}→${b}, using straight line`);
    return [stations[a], stations[b]];
  }

  function searchTrack(g: TrackGraph, a: string, b: string): LngLat[] | undefined {
    const { adj: trackAdj, coord } = g;
    const sources = trackNodesFor(g, a);
    const targets = new Set(trackNodesFor(g, b));
    if (!sources.length || !targets.size) return undefined;
    const limit = dist(stations[a], stations[b]) * 3 + 1500;
    const d = new Map<number, number>();
    const prev = new Map<number, number>();
    const heap = new MinHeap();
    for (const s of sources) { d.set(s, 0); heap.push(0, s); }
    let hit: number | undefined;
    while (heap.size) {
      const [du, u] = heap.pop();
      if (du > (d.get(u) ?? Infinity)) continue;
      if (targets.has(u)) { hit = u; break; }
      if (du > limit) break;
      for (const v of trackAdj.get(u)!) {
        const dv = du + dist(coord.get(u)!, coord.get(v)!);
        if (dv < (d.get(v) ?? Infinity)) { d.set(v, dv); prev.set(v, u); heap.push(dv, v); }
      }
    }
    if (hit === undefined) return undefined;
    const out: LngLat[] = [];
    for (let u: number | undefined = hit; u !== undefined; u = prev.get(u)) out.push(coord.get(u)!);
    return simplify(out.reverse(), 3);
  }

  function stationPath(from: string, to: string): string[] {
    if (!adj.has(from) || !adj.has(to)) throw new Error(`${def.name}: unknown station ${adj.has(from) ? to : from}`);
    const prev = new Map<string, string>([[from, from]]);
    const queue = [from];
    while (queue.length) {
      const u = queue.shift()!;
      if (u === to) break;
      for (const v of adj.get(u)!) if (!prev.has(v)) { prev.set(v, u); queue.push(v); }
    }
    if (!prev.has(to)) throw new Error(`${def.name}: no path ${from}→${to}`);
    const out = [to];
    while (out[0] !== from) out.unshift(prev.get(out[0])!);
    return out;
  }

  const chains: NetworkChain[] = def.chains.map((c) => {
    const names = [c.via[0]];
    for (let i = 1; i < c.via.length; i++) names.push(...stationPath(c.via[i - 1], c.via[i]).slice(1));
    if (new Set(names).size !== names.length) throw new Error(`${def.name}: chain ${c.via.join("→")} repeats a station`);
    if (c.loop && !adj.get(names.at(-1)!)?.has(names[0])) warn(`${def.name}: loop ${names.at(-1)}→${names[0]} not adjacent`);

    const legs = names.slice(1).map((n, i) => [names[i], n]);
    if (c.loop) legs.push([names.at(-1)!, names[0]]);
    const p: LngLat[] = [];
    const at: number[] = [];
    for (const [a, b] of legs) {
      const seg = trackPath(a, b);
      at.push(p.length ? p.length - 1 : 0);
      p.push(...(p.length ? seg.slice(1) : seg));
    }
    if (!c.loop) at.push(p.length - 1);
    // Station markers sit on the drawn track.
    names.forEach((n, i) => {
      if (!(n in stations)) return;
      stations[n] = p[at[i]];
    });
    return { loop: !!c.loop, stations: names, path: p, at };
  });

  const used = new Set(chains.flatMap((c) => c.stations));
  for (const n of Object.keys(stations)) if (!used.has(n)) {
    warn(`${def.name}: station ${n} isn't on any chain`);
    delete stations[n];
  }

  const total = chains.reduce((s, c) => s + pathLength(c.path), 0);
  console.log(`${def.name.padEnd(8)} ${String(used.size).padStart(3)} stations  ${chains.length} chain(s)  ${(total / 1000).toFixed(1)} km  (${routes.length} OSM routes)`);
  return { id: def.id, name: def.name, short: def.short, color: def.color, apiIds: def.apiIds, stations, chains };
}

// ---------- main ----------

const elements = await loadOsm(process.argv.includes("--refresh"));
const nodes = new Map<number, OsmNode>();
const ways = new Map<number, OsmWay>();
const rels: OsmRel[] = [];
for (const e of elements) {
  if (e.type === "node") nodes.set(e.id, e);
  else if (e.type === "way") ways.set(e.id, e);
  else rels.push(e);
}

const round = (p: LngLat): LngLat => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
const namedStops = rels
  .flatMap((r) => r.members.filter((m) => m.type === "node" && m.role.startsWith("stop")))
  .map((m) => nodes.get(m.ref))
  .filter((n): n is OsmNode => !!(n?.tags?.name ?? n?.tags?.["name:ko"]));
const allTracks = trackGraph(rels);

const lines = LINES.map(buildLine).map((l) => ({
  ...l,
  stations: Object.fromEntries(Object.entries(l.stations).map(([k, v]) => [k, round(v)])),
  chains: l.chains.map((c) => ({ ...c, path: c.path.map(round) })),
}));

const network: Network = {
  generated: new Date().toISOString(),
  attribution: "© OpenStreetMap contributors (ODbL)",
  lines,
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(network));
console.log(`\nwrote ${path.relative(root, outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB), ${warnings.length} warning(s)`);
