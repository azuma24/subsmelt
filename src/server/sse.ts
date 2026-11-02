import type { Response } from "express";

// Active SSE connections
const clients = new Set<Response>();
// One heartbeat for every client: a timer per connection let an unbounded
// client set grow timers (and file descriptors) without limit.
let heartbeat: ReturnType<typeof setInterval> | null = null;
// Beyond this, new subscribers are refused: an EventSource storm must not be
// able to exhaust file descriptors and take the whole server down.
const MAX_CLIENTS = 100;

function startHeartbeat() {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    for (const client of clients) {
      try {
        client.write(":\n\n");
      } catch {
        clients.delete(client);
        stopHeartbeat();
      }
    }
  }, 30000);
}

function stopHeartbeat() {
  if (clients.size === 0 && heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

export function addSSEClient(res: Response) {
  if (clients.size >= MAX_CLIENTS) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("Too many live connections");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable nginx buffering
  });
  res.write(":\n\n"); // comment to establish connection

  clients.add(res);
  startHeartbeat();

  res.on("close", () => {
    clients.delete(res);
    stopHeartbeat();
  });
}

export function broadcast(event: string, data: object) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(payload);
    } catch {
      clients.delete(client);
    }
  }
}

export function getClientCount() {
  return clients.size;
}
