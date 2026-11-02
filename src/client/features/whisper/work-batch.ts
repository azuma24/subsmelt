import type { TranscriptionWork } from "../../api.js";

/** Cancel only work belonging to the batch displayed by the picker. */
export function cancellableBatchIds(work: TranscriptionWork[], batchId?: string): string[] {
  if (!batchId) return [];
  return work
    .filter((item) => item.batchId === batchId && (item.status === "queued" || item.status === "running"))
    .map((item) => item.id);
}
