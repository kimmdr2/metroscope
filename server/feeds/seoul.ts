import { normalizeStation, type LineDef } from "../lines.js";
import type { Arrival, Direction, Feed, Snapshot, Train } from "../types.js";

/** One row of the 서울시 실시간 열차 위치정보 (realtimePosition) API. */
interface PositionRow {
  trainNo: string;
  statnNm: string;
  statnTnm: string; // 종착역
  updnLine: string; // "0" 상행/내선, "1" 하행/외선
  trainSttus: string; // "0" 진입, "1" 도착, "2" 출발, "3" 전역출발
  directAt: string; // "1" 급행
}

// How far from the reported station the train probably is, in its direction of travel.
const STATUS_OFFSET: Record<string, number> = { "0": -0.25, "1": 0, "2": 0.15, "3": -0.6 };

export class SeoulFeed implements Feed {
  private last = new Map<string, { station: number; status: string }>();

  constructor(
    private line: LineDef,
    private apiKey: string,
    public intervalMs = 20000,
  ) {}

  async next(): Promise<Snapshot> {
    // The API only serves plain http.
    const url = `http://swopenapi.seoul.go.kr/api/subway/${this.apiKey}/json/realtimePosition/0/200/${encodeURIComponent(this.line.name)}`;
    const res = await fetch(url);
    const body: any = await res.json();
    const rows: PositionRow[] = body.realtimePositionList ?? [];
    if (!rows.length && body.errorMessage?.code && body.errorMessage.code !== "INFO-000") {
      throw new Error(`${body.errorMessage.code}: ${body.errorMessage.message}`);
    }

    const n = this.line.stations.length;
    const trains: Train[] = [];
    const arrivals: Arrival[] = [];

    for (const r of rows) {
      const station = this.line.stations.indexOf(normalizeStation(r.statnNm));
      if (station === -1) continue; // branch line or unknown station
      // Verified against live data: 내선 ("0") runs in station-list order.
      const dir: Direction = r.updnLine === "0" ? 1 : -1;
      const offset = STATUS_OFFSET[r.trainSttus] ?? 0;
      const pos = (((station + dir * offset) % n) + n) % n;
      trains.push({ id: r.trainNo, dir, pos, dest: r.statnTnm, express: r.directAt === "1" });

      const prev = this.last.get(r.trainNo);
      if (r.trainSttus === "1" && (!prev || prev.station !== station || prev.status !== "1")) {
        arrivals.push({ trainId: r.trainNo, dir, station });
      }
      this.last.set(r.trainNo, { station, status: r.trainSttus });
    }

    return {
      line: this.line.name,
      color: this.line.color,
      loop: this.line.loop,
      stations: this.line.stations,
      trains,
      arrivals,
      source: "live",
      ts: Date.now(),
    };
  }
}
