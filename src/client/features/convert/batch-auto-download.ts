import type { ConvertBatch } from "../../api";

/** Only a batch submitted by this mounted page may start an automatic download. */
export function shouldAutoDownload(batch: ConvertBatch | null, submittedId: string | null): boolean {
  return batch?.status === "done" && batch.id === submittedId;
}
