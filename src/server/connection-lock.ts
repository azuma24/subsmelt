import { logger } from "./logger.js";

/**
 * Per-connection serialization for LLM requests.
 *
 * Each connection has a promise chain; acquiring appends a link and waits for the
 * previous holder. A queue worker holds its primary connection's lock for a whole
 * job, while a chunk that cascades needs a *different* connection's lock — so two
 * workers cascading into each other's primaries would wait on each other forever.
 *
 * The lock is a throughput optimisation (don't hammer one endpoint concurrently),
 * never a correctness guarantee, so the wait is bounded: past the deadline the
 * caller proceeds without the lock instead of deadlocking. The chain is extended
 * either way, so later acquirers still queue normally behind this holder.
 */

export const CONNECTION_LOCK_WAIT_MS = 30_000;

export interface LockableConnection {
  id: string;
  label: string;
}

const lockTails = new Map<string, Promise<void>>();
// Links in each chain not yet released; zero means the connection is free.
const outstanding = new Map<string, number>();
const waitWarned = new Set<string>();

export async function acquireConnectionLock(
  conn: LockableConnection,
  waitMs: number = CONNECTION_LOCK_WAIT_MS
): Promise<() => void> {
  const previous = lockTails.get(conn.id) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => { releaseCurrent = resolve; });
  lockTails.set(conn.id, previous.then(() => current));
  outstanding.set(conn.id, (outstanding.get(conn.id) ?? 0) + 1);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const acquired = await Promise.race([
    previous.then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), waitMs); }),
  ]);
  if (timer) clearTimeout(timer);

  if (!acquired && !waitWarned.has(conn.id)) {
    waitWarned.add(conn.id);
    logger.warn(
      "queue",
      `Connection ${conn.label} stayed busy for ${Math.round(waitMs / 1000)}s; proceeding without its lock to avoid stalling the queue.`
    );
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    outstanding.set(conn.id, (outstanding.get(conn.id) ?? 1) - 1);
    releaseCurrent();
  };
}

/**
 * Take the lock only when the connection is free; otherwise proceed at once
 * without it. For a chunk cascading onto another worker's primary: in parallel
 * mode that connection is held for the other worker's whole job, so waiting
 * meant every cascaded chunk paid the full CONNECTION_LOCK_WAIT_MS and then
 * ran unlocked anyway.
 */
export async function tryAcquireConnectionLock(
  conn: LockableConnection
): Promise<() => void> {
  if ((outstanding.get(conn.id) ?? 0) > 0) return () => {};
  return acquireConnectionLock(conn);
}

/** Drop all lock state — called when a queue run starts and finishes. */
export function resetConnectionLocks(): void {
  lockTails.clear();
  outstanding.clear();
  waitWarned.clear();
}
