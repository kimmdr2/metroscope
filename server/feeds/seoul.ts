import { normalizeStation, stationOnLine } from "../lines.js";
import { stationIndex } from "../network.js";
import type { Arrival, Direction, Feed, Network, NetworkLine, Snapshot, Train } from "../types.js";

/** One row of the 서울시 실시간 도착정보 (realtimeStationArrival/ALL) API. */
interface ArrivalRow {
  subwayId: string;
  statnId: string;
  statnNm: string;
  statnFid: string; // previous station, in this train's direction of travel
  statnTid: string; // next station
  btrainNo: string;
  bstatnNm: string; // 종착역
  btrainSttus: string; // 일반 / 급행 / ITX / 특급
  arvlCd: string; // 0 진입, 1 도착, 2 출발, 3 전역출발, 4 전역진입, 5 전역도착, 99 운행중
  arvlMsg3: string; // station the train is currently at/near
  recptnDt: string; // "2026-10-12 16:37:57" KST
}

// How precisely each code pins the train down; the most precise of a train's latest rows wins.
const RANK: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 1, "5": 1, "4": 2, "99": 3 };
// Rows older than this are trains that have left service.
const STALE_MS = 8 * 60_000;

interface Placed {
  train: Train;
  /** Station index the train is stopped at, if any (code 1). */
  at?: number;
}

const kstTime = (s: string) => Date.parse(`${s.replace(" ", "T")}+09:00`);

/**
 * Live positions for every line from a single realtimeStationArrival/ALL call.
 * Each station lists its next approaching trains; a train's position is read from its freshest,
 * most precise row. The previous/next station ids in each row give the direction of travel.
 */
export class SeoulFeed implements Feed {
  readonly source = "live";
  private lineByApi = new Map<string, NetworkLine>();
  private index = new Map<string, ReturnType<typeof stationIndex>>();
  /** API station id -> normalized name; learned from the rows themselves. */
  private stationName = new Map<string, string>();
  /** trainId -> station index it last arrived at ("chain:idx") */
  private lastStop = new Map<string, string>();
  private bootstrapped = false;
  private unknown = new Set<string>();

  constructor(
    network: Network,
    private apiKey: string,
    public intervalMs = 75000,
  ) {
    for (const line of network.lines) {
      for (const id of line.apiIds) this.lineByApi.set(id, line);
      this.index.set(line.id, stationIndex(line));
    }
  }

  async next(): Promise<Snapshot> {
    // The API only serves plain http.
    const url = `http://swopenapi.seoul.go.kr/api/subway/${this.apiKey}/json/realtimeStationArrival/ALL`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: any = await res.json();
    const rows: ArrivalRow[] = body.realtimeArrivalList ?? [];
    const status = body.errorMessage ?? body;
    if (!rows.length && status?.code && status.code !== "INFO-000") {
      throw new Error(`${status.code}: ${status.message}`);
    }

    for (const r of rows) this.stationName.set(r.statnId, normalizeStation(r.statnNm));

    // Freshest, most precise row per train. Some rows carry timestamps in the future (seen:
    // 8호선 at 23:58 in the afternoon, 신분당선 minutes ahead), so they're clamped to now rather
    // than trusted as the reference clock.
    const now = Date.now();
    const time = (r: ArrivalRow) => Math.min(kstTime(r.recptnDt) || 0, now);
    const best = new Map<string, ArrivalRow>();
    for (const r of rows) {
      const line = this.lineByApi.get(r.subwayId);
      if (!line || !r.btrainNo) continue;
      const t = time(r);
      if (now - t > STALE_MS) continue;
      const id = `${line.id}:${r.btrainNo}`;
      const cur = best.get(id);
      const better = !cur || t > time(cur) || (t === time(cur) && (RANK[r.arvlCd] ?? 9) < (RANK[cur.arvlCd] ?? 9));
      if (better) best.set(id, r);
    }

    const trains: Train[] = [];
    const arrivals: Arrival[] = [];
    const seen = new Set<string>();
    const liveLines = new Set<string>();
    for (const r of rows) {
      const line = this.lineByApi.get(r.subwayId);
      if (line) liveLines.add(line.id);
    }

    for (const [id, r] of best) {
      const line = this.lineByApi.get(r.subwayId)!;
      const placed = this.place(line, id, r);
      if (!placed) continue;
      trains.push(placed.train);
      seen.add(id);

      const key = placed.at === undefined ? undefined : `${placed.train.chain}:${placed.at}`;
      if (key && this.lastStop.get(id) !== key) {
        this.lastStop.set(id, key);
        // Skip the first poll: every train already standing at a station would "arrive" at once.
        if (this.bootstrapped) arrivals.push({ line: line.id, chain: placed.train.chain, station: placed.at!, dir: placed.train.dir });
      }
    }
    for (const id of this.lastStop.keys()) if (!seen.has(id)) this.lastStop.delete(id);
    this.bootstrapped = true;

    return {
      source: "live",
      ts: Date.now(),
      intervalMs: this.intervalMs,
      lines: [...liveLines],
      trains,
      arrivals,
    };
  }

  private place(line: NetworkLine, id: string, r: ArrivalRow): Placed | undefined {
    const index = this.index.get(line.id)!;
    const on = (name: string | undefined) => (name === undefined ? undefined : stationOnLine(line.id, name));
    const S = on(r.statnNm)!;
    const F = on(this.stationName.get(r.statnFid));
    const T = on(this.stationName.get(r.statnTid));
    const options = index.get(S);
    if (!options) {
      this.warnUnknown(line, S);
      return;
    }
    // At a junction the station is on several chains; pick the one that also has a neighbor.
    const has = (name: string | undefined, chain: number) => !!name && name !== S && index.get(name)?.some((o) => o.chain === chain);
    const opt = options.find((o) => has(F, o.chain)) ?? options.find((o) => has(T, o.chain)) ?? options[0];
    const chain = line.chains[opt.chain];
    const n = chain.stations.length;
    const idxOf = (name: string | undefined) => (name && name !== S ? index.get(name)?.find((o) => o.chain === opt.chain)?.idx : undefined);
    const s = opt.idx;
    let f = idxOf(F);
    let t = idxOf(T);

    const signed = (from: number, to: number) => {
      let d = to - from;
      if (chain.loop) d = ((d % n) + n + n / 2) % n - n / 2; // shortest way around
      return d;
    };
    const dest = r.bstatnNm ? on(r.bstatnNm) : undefined;
    // On a line with ends, the destination says which way the train is going. On loops it
    // doesn't (a train may go the long way round), so there the previous/next ids decide.
    const toDest = chain.loop ? undefined : this.towards(line, opt.chain, s, dest);
    // "99 운행중" rows are about a station up ahead; the train itself is at arvlMsg3.
    const here = r.arvlCd === "99" ? idxOf(on(r.arvlMsg3 ?? "")) : undefined;
    let dir: Direction;
    if (here !== undefined && signed(here, s) !== 0) dir = signed(here, s) > 0 ? 1 : -1;
    else if (toDest !== undefined) {
      dir = toDest;
      // Some lines (공항철도) report previous and next station swapped.
      const flipped = f !== undefined ? signed(f, s) * dir < 0 : t !== undefined && signed(s, t) * dir < 0;
      if (flipped) [f, t] = [t, f];
    } else if (f !== undefined) dir = signed(f, s) >= 0 ? 1 : -1;
    else if (t !== undefined) dir = signed(s, t) >= 0 ? 1 : -1;
    else dir = s === 0 ? -1 : 1; // at a chain end with nothing else to go on

    const prev = f ?? s - dir; // previous stop (may be several stations back for express trains)
    let pos: number;
    let moving = true;
    let at: number | undefined;
    switch (r.arvlCd) {
      case "0": pos = s - dir * 0.15; break; // 진입
      case "1": pos = s; moving = false; at = s; break; // 도착
      case "2": pos = s + dir * 0.08; break; // 출발
      case "3": pos = prev + signed(prev, s) * 0.4; break; // 전역출발
      case "4": pos = prev - dir * 0.15; break; // 전역진입
      case "5": pos = prev; moving = false; break; // 전역도착
      default:
        pos = here ?? prev;
    }
    pos = chain.loop ? ((pos % n) + n) % n : Math.min(n - 1, Math.max(0, pos));

    const express = /급행|특급|ITX/.test(r.btrainSttus ?? "");
    return { train: { id, line: line.id, chain: opt.chain, pos: Math.round(pos * 1000) / 1000, dir, moving, dest, express }, at };
  }

  /** Which way along the chain gets closer to `dest`, measured over the whole line's station graph. */
  private towards(line: NetworkLine, chain: number, s: number, dest: string | undefined): Direction | undefined {
    if (!dest) return;
    const hops = this.hopsFrom(line, dest);
    if (!hops) return;
    const c = line.chains[chain];
    const n = c.stations.length;
    const at = (i: number) => (c.loop ? c.stations[(i + n) % n] : c.stations[i]);
    const ahead = hops.get(at(s + 1) ?? "") ?? Infinity;
    const behind = hops.get(at(s - 1) ?? "") ?? Infinity;
    if (ahead === behind) return;
    return ahead < behind ? 1 : -1;
  }

  private hopCache = new Map<string, Map<string, number>>();
  private hopsFrom(line: NetworkLine, dest: string) {
    const key = `${line.id}:${dest}`;
    if (this.hopCache.has(key)) return this.hopCache.get(key);
    if (!this.index.get(line.id)!.has(dest)) return;
    const adj = new Map<string, string[]>();
    const link = (a: string, b: string) => {
      adj.set(a, [...(adj.get(a) ?? []), b]);
      adj.set(b, [...(adj.get(b) ?? []), a]);
    };
    for (const c of line.chains) {
      c.stations.forEach((name, i) => i && link(c.stations[i - 1], name));
      if (c.loop) link(c.stations.at(-1)!, c.stations[0]);
    }
    const hops = new Map([[dest, 0]]);
    const queue = [dest];
    while (queue.length) {
      const u = queue.shift()!;
      for (const v of adj.get(u) ?? []) if (!hops.has(v)) { hops.set(v, hops.get(u)! + 1); queue.push(v); }
    }
    this.hopCache.set(key, hops);
    return hops;
  }

  private warnUnknown(line: NetworkLine, name: string) {
    const key = `${line.name} ${name}`;
    if (this.unknown.has(key)) return;
    this.unknown.add(key);
    console.warn(`unknown station: ${key} (add an alias in server/lines.ts?)`);
  }
}
