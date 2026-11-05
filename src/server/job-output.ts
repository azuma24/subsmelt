import { getJobOutputOwner } from "./db.js";
import { removePartialOutput } from "./translator/engine.js";

/** A legacy duplicate may point at the partial output of a different job. */
export function removeJobPartialOutput(outputPath: string, ownerId?: number): void {
  const owner = getJobOutputOwner(outputPath);
  if (!owner || (owner.id === ownerId && owner.status !== "translating")) removePartialOutput(outputPath);
}
