/** +1 = 외선 (clockwise in station order), -1 = 내선 */
export type Direction = 1 | -1;

export interface Train {
  id: string;
  dir: Direction;
  /** Fractional station index along the line, 0 <= pos < stations.length */
  pos: number;
  dest?: string;
  express?: boolean;
}

export interface Arrival {
  trainId: string;
  dir: Direction;
  station: number;
}

export interface Snapshot {
  line: string;
  color: string;
  loop: boolean;
  stations: string[];
  trains: Train[];
  arrivals: Arrival[];
  source: "live" | "mock";
  ts: number;
}

export interface Feed {
  /** Returns the next snapshot; called on every tick. */
  next(): Promise<Snapshot>;
  intervalMs: number;
}
