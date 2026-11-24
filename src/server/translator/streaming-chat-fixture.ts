/**
 * Test support for fake OpenAI-compatible endpoints. Tests describe a reply as
 * one whole `chat.completion`; translation requests ask for `stream: true`, so
 * the same reply has to be served as server-sent events as well.
 */

interface Completion {
  object?: string;
  choices: { message: Record<string, unknown>; finish_reason: string }[];
  usage?: unknown;
}

interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

/** The SSE body a streaming server sends for a reply it would otherwise return whole. */
export function completionAsSse(completion: Completion): string {
  const { message, finish_reason } = completion.choices[0];
  const toolCalls = (message.tool_calls as ToolCall[] | undefined)?.map((call, index) => ({ index, ...call }));
  const chunk = (fields: object) =>
    `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 0, model: "test-model", ...fields })}\n\n`;
  return [
    chunk({ choices: [{ index: 0, delta: { ...message, tool_calls: toolCalls }, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason }] }),
    completion.usage ? chunk({ choices: [], usage: completion.usage }) : "",
    "data: [DONE]\n\n",
  ].join("");
}

export function wantsStream(requestBody: unknown): boolean {
  return typeof requestBody === "string" && requestBody.includes('"stream":true');
}

/** Wraps a fake fetch so its whole chat completions are streamed to requests that asked for a stream. */
export function streamable(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetchImpl(input as URL, init);
    if (!response.ok || !wantsStream(init?.body)) return response;
    const body = await response.text();
    const completion = JSON.parse(body) as Completion;
    if (completion.object !== "chat.completion") return new Response(body, response);
    return new Response(completionAsSse(completion), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}
