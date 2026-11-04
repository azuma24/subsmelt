import { controlledAbortError } from "./ai-client.js";

/**
 * A counting semaphore whose limit can only shrink.
 *
 * Chunk workers take a slot per chunk. When the model server runs out of
 * shared context, the limit halves and workers above it wait instead of
 * sending requests that would overflow again.
 */
export interface ConcurrencyGate {
  readonly limit: number;
  acquire(signal?: AbortSignal): Promise<void>;
  release(): void;
  /**
   * Halve the limit a caller observed when it started. Concurrent callers that
   * saw the same limit halve it once between them. Returns true when it shrank.
   */
  halveFrom(observedLimit: number): boolean;
}

export function createConcurrencyGate(initialLimit: number): ConcurrencyGate {
  let limit = Math.max(1, initialLimit);
  let running = 0;
  const waiting: Array<() => void> = [];

  return {
    get limit() {
      return limit;
    },
    async acquire(signal?: AbortSignal) {
      while (running >= limit) {
        if (signal?.aborted) throw controlledAbortError(signal);
        await new Promise<void>((resolve, reject) => {
          const wake = () => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          };
          const onAbort = () => {
            const at = waiting.indexOf(wake);
            if (at >= 0) waiting.splice(at, 1);
            signal?.removeEventListener("abort", onAbort);
            reject(controlledAbortError(signal!));
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          if (running < limit) {
            wake();
            return;
          }
          waiting.push(wake);
        });
      }
      running++;
    },
    release() {
      running--;
      waiting.shift()?.();
    },
    halveFrom(observedLimit) {
      const next = Math.max(1, Math.floor(observedLimit / 2));
      if (next >= limit) return false;
      limit = next;
      return true;
    },
  };
}
