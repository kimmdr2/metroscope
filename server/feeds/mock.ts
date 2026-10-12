import { segmentLengths } from "../network.js";
import type { Arrival, Direction, Feed, Network, Snapshot, Train } from "../types.js";

interface SimTrain extends Train {
  speed: number; // meters per second (real time)
  dwell: number; // seconds left stopped at a station
}

interface SimChain {
  line: string;
  chain: number;
  n: number;
  loop: boolean;
  seg: number[];
  stations: string[];
}

/**
 * Simulated trains on every line, for development without an API key.
 * Trains start at random spacing so bunching and big gaps appear naturally, run at a realistic
 * speed along the real track length, and turn back at termini.
 */
export class MockFeed implements Feed {
  readonly source = "mock";
  intervalMs = 1000;
  private trains: SimTrain[] = [];
  private chains: SimChain[] = [];
  private lineIds: string[];

  constructor(network: Network, private timeScale = 8) {
    this.lineIds = network.lines.map((l) => l.id);
    for (const line of network.lines) {
      // GTX-A covers long distances between few stations, so it runs much faster.
      const fast = line.id === "GA" ? 2.4 : 1;
      line.chains.forEach((c, chain) => {
        const sim: SimChain = { line: line.id, chain, n: c.stations.length, loop: c.loop, seg: segmentLengths(c), stations: c.stations };
        this.chains.push(sim);
        const perDir = Math.max(1, Math.round(sim.n / (c.loop ? 2 : 3)));
        for (const dir of [1, -1] as Direction[]) {
          for (let i = 0; i < perDir; i++) {
            const span = c.loop ? sim.n : sim.n - 1;
            this.trains.push({
              // Even numbers one way, odd the other, like real timetables.
              id: `${line.id}:${1000 + chain * 200 + i * 2 + (dir > 0 ? 0 : 1)}`,
              line: line.id,
              chain,
              dir,
              dest: this.terminus(sim, dir),
              pos: Math.random() * span,
              moving: true,
              speed: 11 * fast * (0.85 + Math.random() * 0.3),
              dwell: 0,
            });
          }
        }
      });
    }
  }

  private terminus(c: SimChain, dir: Direction) {
    return c.loop ? undefined : c.stations[dir > 0 ? c.n - 1 : 0];
  }

  async next(): Promise<Snapshot> {
    const dt = (this.intervalMs / 1000) * this.timeScale;
    const arrivals: Arrival[] = [];
    const chainOf = new Map(this.chains.map((c) => [`${c.line}:${c.chain}`, c]));

    for (const t of this.trains) {
      const c = chainOf.get(`${t.line}:${t.chain}`)!;
      if (t.dwell > 0) {
        t.dwell = Math.max(0, t.dwell - dt);
        t.moving = t.dwell === 0;
        continue;
      }
      // Segment we're on, in direction of travel.
      const i = t.dir > 0 ? Math.floor(t.pos) : Math.ceil(t.pos) - 1;
      const segLen = c.seg[((i % c.seg.length) + c.seg.length) % c.seg.length];
      const after = t.pos + (t.dir * t.speed * dt) / segLen;
      const crossed = t.dir > 0 ? Math.floor(after) > Math.floor(t.pos) : Math.ceil(after) < Math.ceil(t.pos);
      if (crossed) {
        // Stop at the next station even if this tick would carry us past it.
        let station = t.dir > 0 ? Math.floor(t.pos) + 1 : Math.ceil(t.pos) - 1;
        if (c.loop) station = ((station % c.n) + c.n) % c.n;
        t.pos = station;
        t.moving = false;
        t.dwell = 25 + Math.random() * 20;
        arrivals.push({ line: t.line, chain: t.chain, station, dir: t.dir });
        if (!c.loop && (station === 0 || station === c.n - 1)) {
          t.dir = station === 0 ? 1 : -1;
          t.dest = this.terminus(c, t.dir);
          t.dwell += 60 + Math.random() * 120;
        }
      } else {
        t.pos = c.loop ? ((after % c.n) + c.n) % c.n : after;
        t.moving = true;
      }
    }

    return {
      source: "mock",
      ts: Date.now(),
      intervalMs: this.intervalMs,
      lines: this.lineIds,
      trains: this.trains.map(({ id, line, chain, dir, pos, moving, dest }) => ({ id, line, chain, dir, pos: Math.round(pos * 1000) / 1000, moving, dest })),
      arrivals,
    };
  }
}
