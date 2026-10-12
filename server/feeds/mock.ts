import type { LineDef } from "../lines.js";
import type { Arrival, Direction, Feed, Snapshot, Train } from "../types.js";

interface SimTrain extends Train {
  speed: number; // stations per second (real time)
  dwell: number; // seconds left stopped at a station
}

/**
 * Simulated trains for development without an API key.
 * Trains start at random spacing so bunching and big gaps appear naturally.
 */
export class MockFeed implements Feed {
  intervalMs = 1000;
  private trains: SimTrain[] = [];

  constructor(
    private line: LineDef,
    private timeScale = 8,
    trainsPerDir = 22,
  ) {
    const n = line.stations.length;
    for (const dir of [1, -1] as Direction[]) {
      for (let i = 0; i < trainsPerDir; i++) {
        this.trains.push({
          id: `${dir > 0 ? "O" : "I"}${2000 + i}`,
          dir,
          pos: Math.random() * n,
          speed: (1 / 120) * (0.85 + Math.random() * 0.3), // ~2 min between stations
          dwell: 0,
        });
      }
    }
  }

  async next(): Promise<Snapshot> {
    const n = this.line.stations.length;
    const dt = (this.intervalMs / 1000) * this.timeScale;
    const arrivals: Arrival[] = [];

    for (const t of this.trains) {
      if (t.dwell > 0) {
        t.dwell = Math.max(0, t.dwell - dt);
        continue;
      }
      const before = t.pos;
      const after = before + t.dir * t.speed * dt;
      // Crossed a station boundary?
      const crossed = t.dir > 0 ? Math.floor(after) > Math.floor(before) : Math.ceil(after) < Math.ceil(before);
      if (crossed) {
        const station = t.dir > 0 ? Math.floor(after) : Math.ceil(after);
        t.pos = ((station % n) + n) % n;
        t.dwell = 25 + Math.random() * 20;
        arrivals.push({ trainId: t.id, dir: t.dir, station: t.pos });
      } else {
        t.pos = ((after % n) + n) % n;
      }
    }

    return {
      line: this.line.name,
      color: this.line.color,
      loop: this.line.loop,
      stations: this.line.stations,
      trains: this.trains.map(({ id, dir, pos }) => ({ id, dir, pos })),
      arrivals,
      source: "mock",
      ts: Date.now(),
    };
  }
}
