import type { TextStreamPart, ToolSet } from "ai";

/** The two members of a streamText result that collecting a reply needs. */
interface ReplyStream<STEP> {
  stream: AsyncIterable<TextStreamPart<ToolSet>>;
  finalStep: PromiseLike<STEP>;
}

/**
 * Reads a streamed reply to its end and resolves with the final step, which
 * has the fields a generateText result has: text, reasoning, usage, finish reason.
 *
 * `onPart` fires for every stream part, so the caller can tell a model that is
 * still producing from one that has gone quiet. The SDK reports provider errors
 * as stream parts instead of throwing; they are thrown here unchanged.
 */
export async function collectReply<STEP>(result: ReplyStream<STEP>, onPart: () => void): Promise<STEP> {
  for await (const part of result.stream) {
    onPart();
    if (part.type === "error") throw part.error;
    if (part.type === "abort") throw new DOMException(part.reason ?? "Stream aborted", "AbortError");
  }
  return await result.finalStep;
}
