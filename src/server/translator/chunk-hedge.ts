import { logger } from "../logger.js";
import type { ResolvedConnection } from "../connections.js";
import { sameMachineAs } from "../machine.js";
import type { SubtitleCue } from "./utils.js";

/** When an idle worker looks for a stalled chunk, and how long a chunk may run first. */
export interface HedgeTiming {
  pollMs: number;
  /** The shortest time a chunk runs before a duplicate is considered. */
  minWaitMs: number;
  /** The wait when no chunk has finished yet, so there is no normal time to compare with. */
  noHistoryWaitMs: number;
}

export const DEFAULT_HEDGE_TIMING: HedgeTiming = {
  pollMs: 1_000,
  minWaitMs: 5_000,
  noHistoryWaitMs: 60_000,
};

/** One chunk being worked on, shared between its original attempt and any duplicate. */
export interface ChunkRecord {
  block: SubtitleCue[];
  /** When the current original attempt started; a requeue starts the clock again. */
  startedAt: number;
  /** The connection the original attempt is trying now. */
  conn: ResolvedConnection | null;
  /** That connection's limit when the attempt reached it, for halving on an overflow. */
  connLimit: number;
  original: ChunkAttempt | null;
  /** The duplicate running now, if any. One at a time, each on a different connection. */
  duplicate: ChunkAttempt | null;
  duplicateDone: Promise<void> | null;
  triedConnIds: Set<string>;
  winner: ChunkAttempt | null;
}

/** One run of the chunk processor over one chunk. */
export interface ChunkAttempt {
  record: ChunkRecord;
  controller: AbortController;
  /** The job signal joined with this attempt's controller. */
  signal: AbortSignal;
  /** Set only on a duplicate: the one connection it tries. */
  targetConn?: ResolvedConnection;
  startedAt: number;
}

export interface ChunkHedgerDeps {
  connections: ResolvedConnection[];
  /** The connections still worth sending work to, in preference order. */
  usable(connections: ResolvedConnection[]): ResolvedConnection[];
  jobSignal: AbortSignal;
  runDuplicate(block: SubtitleCue[], attempt: ChunkAttempt): Promise<unknown>;
  timing?: Partial<HedgeTiming>;
}

/** Connections not on a machine this job has found down, whichever connection found it. */
export function awayFromDownMachines(
  order: ResolvedConnection[],
  connections: ResolvedConnection[],
  isDown: (id: string) => boolean,
): ResolvedConnection[] {
  const down = connections.filter((conn) => isDown(conn.id));
  return order.filter((conn) => !down.some((other) => other.id === conn.id || sameMachineAs(other, conn)));
}

export interface ChunkHedger {
  /** Starts or restarts the original attempt of a chunk a worker picked up. */
  startOriginal(block: SubtitleCue[]): ChunkAttempt;
  /** The chunk's work is over: stop tracking it. */
  finish(block: SubtitleCue[]): void;
  /** Claims the write for this attempt and terminates the other one. False when the other already won. */
  claimWin(attempt: ChunkAttempt): boolean;
  /** Resolves once no duplicate of this chunk is running, so its outcome is known. */
  waitForDuplicate(record: ChunkRecord): Promise<void>;
  /**
   * Keeps a worker with no chunks left busy until every chunk has settled,
   * sending stalled chunks to another machine. An error from a duplicate that
   * already won is real and propagates; any other duplicate failure is ignored.
   */
  runIdleLoop(): Promise<void>;
}

export function createChunkHedger(deps: ChunkHedgerDeps): ChunkHedger {
  const { connections, usable, jobSignal, runDuplicate } = deps;
  const timing = { ...DEFAULT_HEDGE_TIMING, ...deps.timing };
  const records = new Map<SubtitleCue[], ChunkRecord>();
  const durations: number[] = [];
  const sleepers = new Set<() => void>();

  function newAttempt(record: ChunkRecord, targetConn?: ResolvedConnection): ChunkAttempt {
    const controller = new AbortController();
    return {
      record,
      controller,
      signal: AbortSignal.any([jobSignal, controller.signal]),
      targetConn,
      startedAt: Date.now(),
    };
  }

  function waitBeforeDuplicate(): number {
    if (durations.length === 0) return timing.noHistoryWaitMs;
    const average = durations.reduce((sum, ms) => sum + ms, 0) / durations.length;
    return Math.max(timing.minWaitMs, 2 * average);
  }

  function targetFor(record: ChunkRecord): ResolvedConnection | undefined {
    return usable(connections).find((conn) => {
      if (record.triedConnIds.has(conn.id) || conn === record.conn) return false;
      return !record.conn || !sameMachineAs(conn, record.conn);
    });
  }

  /** The longest-running chunk that has waited long enough and has somewhere to go. */
  function nextDuplicate(now: number): { record: ChunkRecord; target: ResolvedConnection } | null {
    const wait = waitBeforeDuplicate();
    const stalled = [...records.values()]
      .filter((record) => !record.winner && !record.duplicate && now - record.startedAt >= wait)
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const record of stalled) {
      const target = targetFor(record);
      if (target) return { record, target };
    }
    return null;
  }

  async function sendDuplicate(record: ChunkRecord, target: ResolvedConnection): Promise<void> {
    const attempt = newAttempt(record, target);
    let settle = () => {};
    record.duplicate = attempt;
    record.duplicateDone = new Promise((resolve) => {
      settle = resolve;
    });
    record.triedConnIds.add(target.id);
    logger.info("translate", `Chunk stalled on ${record.conn?.label ?? "?"}: sending a duplicate to ${target.label}`);
    try {
      await runDuplicate(record.block, attempt);
    } catch (error) {
      if (record.winner === attempt) throw error;
    } finally {
      record.duplicate = null;
      record.duplicateDone = null;
      settle();
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        jobSignal.removeEventListener("abort", wake);
        sleepers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      jobSignal.addEventListener("abort", wake, { once: true });
      sleepers.add(wake);
    });
  }

  return {
    startOriginal(block) {
      const existing = records.get(block);
      const record: ChunkRecord = existing ?? {
        block,
        startedAt: 0,
        conn: null,
        connLimit: 1,
        original: null,
        duplicate: null,
        duplicateDone: null,
        triedConnIds: new Set(),
        winner: null,
      };
      record.startedAt = Date.now();
      record.original = newAttempt(record);
      records.set(block, record);
      return record.original;
    },
    finish(block) {
      records.delete(block);
      if (records.size === 0) for (const wake of [...sleepers]) wake();
    },
    claimWin(attempt) {
      const { record } = attempt;
      if (record.winner) return false;
      record.winner = attempt;
      durations.push(Date.now() - attempt.startedAt);
      const isDuplicate = attempt.targetConn !== undefined;
      const other = isDuplicate ? record.original : record.duplicate;
      other?.controller.abort();
      if (isDuplicate) {
        logger.info("translate", `${attempt.targetConn?.label} answered first: ended the stalled request`);
      } else if (other) {
        logger.info("translate", `${record.conn?.label ?? "?"} answered first: ended the duplicate`);
      }
      return true;
    },
    async waitForDuplicate(record) {
      while (record.duplicateDone) await record.duplicateDone;
    },
    async runIdleLoop() {
      while (records.size > 0 && !jobSignal.aborted) {
        await sleep(timing.pollMs);
        if (jobSignal.aborted) return;
        const next = nextDuplicate(Date.now());
        if (next) await sendDuplicate(next.record, next.target);
      }
    },
  };
}
