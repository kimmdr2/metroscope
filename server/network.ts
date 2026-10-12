import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LngLat, Network, NetworkChain, NetworkLine } from "./types.js";

export const NETWORK_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "network.json");

export function loadNetwork(): Network {
  return JSON.parse(fs.readFileSync(NETWORK_FILE, "utf8"));
}

const R_EARTH = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
function dist(a: LngLat, b: LngLat) {
  const x = rad(b[0] - a[0]) * Math.cos(rad((a[1] + b[1]) / 2));
  const y = rad(b[1] - a[1]);
  return Math.hypot(x, y) * R_EARTH;
}

/** Track length in meters of each station-to-station segment (loops include the closing one). */
export function segmentLengths(chain: NetworkChain): number[] {
  const at = chain.loop ? [...chain.at, chain.path.length - 1] : chain.at;
  return at.slice(1).map((end, i) => {
    let len = 0;
    for (let k = at[i]; k < end; k++) len += dist(chain.path[k], chain.path[k + 1]);
    return Math.max(len, 1);
  });
}

/** Station name -> every (chain, index) it appears at on this line. */
export function stationIndex(line: NetworkLine): Map<string, { chain: number; idx: number }[]> {
  const out = new Map<string, { chain: number; idx: number }[]>();
  line.chains.forEach((c, chain) =>
    c.stations.forEach((name, idx) => {
      if (!out.has(name)) out.set(name, []);
      out.get(name)!.push({ chain, idx });
    }),
  );
  return out;
}
