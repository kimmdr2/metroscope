// Geometry along a chain: everything is measured in meters along the track.

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function dist(a, b) {
  const x = rad(b[0] - a[0]) * Math.cos(rad((a[1] + b[1]) / 2));
  const y = rad(b[1] - a[1]);
  return Math.hypot(x, y) * R;
}

/** Adds cumulative distances so positions can be looked up quickly. */
export function prepareChain(chain) {
  const { path, at, loop, stations } = chain;
  const cum = new Float64Array(path.length);
  for (let i = 1; i < path.length; i++) cum[i] = cum[i - 1] + dist(path[i - 1], path[i]);
  const stationD = at.map((i) => cum[i]);
  if (loop) stationD.push(cum[path.length - 1]);
  return { ...chain, n: stations.length, cum, stationD, total: cum[path.length - 1] };
}

/** Fractional station index -> meters along the chain. */
export function distOfPos(c, pos) {
  if (c.loop) pos = ((pos % c.n) + c.n) % c.n;
  else pos = Math.min(c.n - 1, Math.max(0, pos));
  const i = Math.floor(pos);
  if (i >= c.stationD.length - 1) return c.stationD[c.stationD.length - 1];
  return c.stationD[i] + (pos - i) * (c.stationD[i + 1] - c.stationD[i]);
}

/** Meters along the chain -> fractional station index. */
export function posOfDist(c, d) {
  d = wrapDist(c, d);
  const s = c.stationD;
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= d) lo = mid;
    else hi = mid;
  }
  const span = s[hi] - s[lo] || 1;
  return lo + Math.min(1, Math.max(0, (d - s[lo]) / span));
}

export function wrapDist(c, d) {
  if (c.loop) return ((d % c.total) + c.total) % c.total;
  return Math.min(c.total, Math.max(0, d));
}

function segmentAt(c, d) {
  const cum = c.cum;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Point and heading (degrees clockwise from north) at `d` meters along the chain. */
export function pointAt(c, d) {
  d = wrapDist(c, d);
  const k = Math.min(segmentAt(c, d), c.path.length - 2);
  const a = c.path[k];
  const b = c.path[k + 1];
  const len = c.cum[k + 1] - c.cum[k] || 1;
  const f = Math.min(1, Math.max(0, (d - c.cum[k]) / len));
  const lng = a[0] + (b[0] - a[0]) * f;
  const lat = a[1] + (b[1] - a[1]) * f;
  const heading = deg(Math.atan2((b[0] - a[0]) * Math.cos(rad(lat)), b[1] - a[1]));
  return { lngLat: [lng, lat], heading };
}

/** Track coordinates from d1 to d2 (d2 > d1; on loops it may run past the end and wrap). */
export function slice(c, d1, d2) {
  if (c.loop && d2 > c.total) {
    const first = slice(c, d1, c.total);
    return first.concat(slice(c, 0, d2 - c.total).slice(1));
  }
  d1 = wrapDist(c, d1);
  d2 = wrapDist(c, d2);
  const out = [pointAt(c, d1).lngLat];
  for (let k = segmentAt(c, d1) + 1; k < c.path.length && c.cum[k] < d2; k++) out.push(c.path[k]);
  out.push(pointAt(c, d2).lngLat);
  return out;
}

/** A ribbon `width` meters wide around a polyline, as a closed polygon ring. */
export function ribbon(coords, width) {
  if (coords.length < 2) return null;
  const lat0 = rad(coords[0][1]);
  const mx = (R * Math.PI) / 180; // meters per degree latitude
  const toXY = ([lng, lat]) => [lng * mx * Math.cos(lat0), lat * mx];
  const toLL = ([x, y]) => [x / (mx * Math.cos(lat0)), y / mx];
  // Drop near-duplicate points: a zero-length step has no direction and would pinch the ribbon.
  const pts = coords.map(toXY).filter((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > 0.5);
  if (pts.length < 2) return null;
  const left = [];
  const right = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const h = width / 2;
    left.push(toLL([p[0] - dy * h, p[1] + dx * h]));
    right.push(toLL([p[0] + dy * h, p[1] - dx * h]));
  }
  return [...left, ...right.reverse(), left[0]];
}
