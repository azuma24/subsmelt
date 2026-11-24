/**
 * When a job last translated a line. Request timeouts are judged against this
 * clock: a request that reaches its own limit is left running while the job is
 * still producing lines, and ends once the job has stalled.
 */
export class JobProgress {
  private lastLineAt = Date.now();

  /** `stallMs` is how long the job may go without a new line before it counts as stalled. */
  constructor(private readonly stallMs: number) {}

  noteLine(): void {
    this.lastLineAt = Date.now();
  }

  /** Milliseconds until the job counts as stalled; zero or less once it has. */
  msUntilStalled(): number {
    return this.lastLineAt + this.stallMs - Date.now();
  }
}
