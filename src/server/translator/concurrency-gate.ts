/**
 * A counting semaphore whose limit can only shrink.
 *
 * Chunk workers take a slot per chunk. When the model server runs out of
 * shared context, the limit halves and workers above it wait instead of
 * sending requests that would overflow again.
 */
export interface ConcurrencyGate {
  readonly limit: number;
  acquire(): Promise<void>;
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
    async acquire() {
      while (running >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
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
