import type { ResolvedConnection } from "../connections.js";
import { serverOf } from "../machine.js";
import { createConcurrencyGate, type ConcurrencyGate } from "./concurrency-gate.js";

/** Hard ceiling on one file's chunk workers. */
export const MAX_SPLIT_WORKERS = 32;

/**
 * One file's chunks sent to every connection at once. Each server is held to
 * its own limit, so a lost machine's workers wait for a slot on a survivor
 * instead of overloading it, and one small context window throttles only its
 * own server. Two connections on one server share a limit and its workers,
 * because they share its context window.
 */
export interface SplitRun {
  /** The connection each worker prefers, by worker index. Its length is the worker count. */
  workerPrimaries: ResolvedConnection[];
  acquire(conn: ResolvedConnection, signal?: AbortSignal): Promise<() => void>;
  limitOf(conn: ResolvedConnection): number;
  /** Halve a connection's limit from the value a caller observed. Returns true when it shrank. */
  halveFrom(conn: ResolvedConnection, observedLimit: number): boolean;
}

export function createSplitRun(connections: ResolvedConnection[], limits: ReadonlyMap<string, number>): SplitRun {
  const limitFor = (conn: ResolvedConnection) => Math.max(1, limits.get(conn.id) ?? 1);
  const servers = new Map<string, ResolvedConnection[]>();
  for (const conn of connections) servers.set(serverOf(conn), [...(servers.get(serverOf(conn)) ?? []), conn]);

  const gates = new Map<string, ConcurrencyGate>();
  for (const [server, sharing] of servers) {
    gates.set(server, createConcurrencyGate(Math.min(...sharing.map(limitFor))));
  }
  const gateOf = (conn: ResolvedConnection) => gates.get(serverOf(conn)) as ConcurrencyGate;

  // One worker per request a server can take: more would only hold chunks at
  // its gate while another server has room.
  const workerPrimaries: ResolvedConnection[] = [];
  const rounds = Math.max(0, ...[...gates.values()].map((gate) => gate.limit));
  for (let round = 0; round < rounds; round++) {
    for (const [server, sharing] of servers) {
      const gate = gates.get(server) as ConcurrencyGate;
      if (round < gate.limit && workerPrimaries.length < MAX_SPLIT_WORKERS) {
        workerPrimaries.push(sharing[round % sharing.length]);
      }
    }
  }

  return {
    workerPrimaries,
    async acquire(conn, signal) {
      const gate = gateOf(conn);
      await gate.acquire(signal);
      return () => gate.release();
    },
    limitOf: (conn) => gateOf(conn).limit,
    halveFrom: (conn, observedLimit) => gateOf(conn).halveFrom(observedLimit),
  };
}
