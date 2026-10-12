import "dotenv/config";
import express, { type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MockFeed } from "./feeds/mock.js";
import { SeoulFeed } from "./feeds/seoul.js";
import { NETWORK_FILE, loadNetwork } from "./network.js";
import type { Feed, Snapshot } from "./types.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const network = loadNetwork();

const apiKey = process.env.SEOUL_API_KEY;
// Daily quota is 1,000 calls. One realtimeStationArrival/ALL call covers every line; polling only
// during service hours (05:30–01:00, 19.5h) at 75s comes to ~936 calls/day.
const feed: Feed = apiKey
  ? new SeoulFeed(network, apiKey, Number(process.env.POLL_MS ?? 75000))
  : new MockFeed(network, Number(process.env.MOCK_SPEED ?? 8));

/** True between 01:00 and 05:30 KST, when no trains run. */
function isNightPause() {
  const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date())
    .split(":")
    .map(Number);
  const minutes = h * 60 + m;
  return minutes >= 60 && minutes < 5 * 60 + 30;
}

// One upstream poll is fanned out to every browser over SSE, so viewers don't cost API calls.
const clients = new Set<Response>();
let latest: Snapshot | undefined;

function broadcast(snap: Snapshot) {
  latest = snap;
  const msg = `data: ${JSON.stringify(snap)}\n\n`;
  for (const c of clients) c.write(msg);
}

async function tick() {
  if (feed.source === "live" && isNightPause()) {
    // Clear the map once instead of leaving the last trains frozen until morning.
    if (!latest?.paused) {
      broadcast({ source: "live", ts: Date.now(), intervalMs: 60_000, lines: [], paused: true, trains: [], arrivals: [] });
    }
    setTimeout(tick, 60_000);
    return;
  }
  try {
    broadcast(await feed.next());
  } catch (err) {
    console.error("feed error:", (err as Error).message);
  }
  setTimeout(tick, feed.intervalMs);
}

const app = express();
app.use(express.static(path.join(root, "web")));
app.use("/vendor/maplibre-gl", express.static(path.join(root, "node_modules", "maplibre-gl", "dist"), { maxAge: "7d" }));
app.get("/network.json", (_req, res) => res.sendFile(NETWORK_FILE, { maxAge: "1h" }));

app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // nginx: don't buffer the stream
  });
  res.flushHeaders();
  if (latest) res.write(`data: ${JSON.stringify({ ...latest, arrivals: [] })}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

// Proxies like Cloudflare drop streams idle for ~100s (e.g. during the night pause).
setInterval(() => {
  for (const c of clients) c.write(": ping\n\n");
}, 30_000);

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  const stations = network.lines.reduce((s, l) => s + Object.keys(l.stations).length, 0);
  console.log(`metroscope on http://localhost:${port} (${feed.source} feed, ${network.lines.length} lines, ${stations} stations)`);
  tick();
});
