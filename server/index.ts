import "dotenv/config";
import express, { type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MockFeed } from "./feeds/mock.js";
import { SeoulFeed } from "./feeds/seoul.js";
import { LINE2 } from "./lines.js";
import type { Feed, Snapshot } from "./types.js";

const apiKey = process.env.SEOUL_API_KEY;
const feed: Feed = apiKey
  ? new SeoulFeed(LINE2, apiKey, Number(process.env.POLL_MS ?? 20000))
  : new MockFeed(LINE2, Number(process.env.MOCK_SPEED ?? 8));

// One upstream poll is fanned out to every browser over SSE, so viewers don't cost API calls.
const clients = new Set<Response>();
let latest: Snapshot | undefined;

async function tick() {
  try {
    latest = await feed.next();
    const msg = `data: ${JSON.stringify(latest)}\n\n`;
    for (const c of clients) c.write(msg);
  } catch (err) {
    console.error("feed error:", (err as Error).message);
  }
  setTimeout(tick, feed.intervalMs);
}

const app = express();
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web")));

app.get("/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.flushHeaders();
  if (latest) res.write(`data: ${JSON.stringify({ ...latest, arrivals: [] })}\n\n`);
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`metroscope on http://localhost:${port} (${apiKey ? "live" : "mock"} feed)`);
  tick();
});
