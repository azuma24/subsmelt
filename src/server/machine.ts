// Names that all mean "this machine": a LLM at localhost and a Whisper backend
// at 127.0.0.1 share one GPU.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

function machineOf(url: string): string | null {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(hostname) ? "loopback" : hostname || null;
  } catch {
    return null;
  }
}

interface ServerAddress {
  id: string;
  apiHost: string;
  provider?: unknown;
}

/**
 * The server a connection's requests land on, however its URL is spelled. A cloud
 * connection has its own, and its apiHost is an unused default, so it never
 * counts as local to anything.
 */
export function serverOf(conn: ServerAddress): string {
  if (conn.provider) return conn.id;
  try {
    const url = new URL(conn.apiHost);
    const machine = machineOf(conn.apiHost) ?? conn.id;
    return `${machine}:${url.port}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return conn.id;
  }
}

/** Both connections run on one machine, so losing it loses them both. */
export function sameMachineAs(a: ServerAddress, b: ServerAddress): boolean {
  return !a.provider && !b.provider && sameMachine(a.apiHost, b.apiHost);
}

/** Both URLs point at the same machine, whatever the ports. */
export function sameMachine(a: string, b: string): boolean {
  const machine = machineOf(a);
  return machine !== null && machine === machineOf(b);
}
