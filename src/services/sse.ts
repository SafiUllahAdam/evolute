/**
 * Server-sent-event helpers for streaming model responses.
 *
 * Streaming does not make a reply finish sooner - it makes it *start* sooner.
 * The old pipeline awaited the entire answer before the chat window drew a
 * single character and before text-to-speech had anything to say, so every
 * question was followed by several seconds of nothing. Reading the reply as it
 * is generated lets the words appear and the voice start on the first
 * sentence, which is most of what "feels live" actually means.
 */

/** Yields the payload of each `data:` line in an SSE body. */
async function* sseEvents(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  if (!body) return;

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      // `stream: true` keeps multi-byte characters intact across chunk
      // boundaries; without it an emoji split down the middle decodes to a
      // replacement character.
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) {
          yield line.slice(5).trim();
        }
      }
    }
  } finally {
    // Releasing matters on the error path: an abandoned reader keeps the
    // socket open until the process exits.
    reader.releaseLock();
  }
}

/**
 * Reads an Anthropic `/v1/messages` stream, forwarding each text delta and
 * returning the assembled reply.
 */
export async function streamAnthropicText(
  body: ReadableStream<Uint8Array> | null,
  onDelta: (chunk: string) => void
): Promise<string> {
  let text = "";

  for await (const payload of sseEvents(body)) {
    let event: {
      type?: string;
      delta?: { type?: string; text?: string };
      error?: { message?: string };
    };
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }

    if (event.type === "error") {
      throw new Error(`Claude API stream error: ${event.error?.message || "unknown"}`);
    }
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      const chunk = event.delta.text || "";
      if (chunk) {
        text += chunk;
        onDelta(chunk);
      }
    }
  }

  return text;
}

/**
 * Reads an OpenAI-shaped `/chat/completions` stream. Covers OpenAI itself,
 * OpenRouter, and the two configurable OpenAI-compatible slots.
 */
export async function streamOpenAIText(
  body: ReadableStream<Uint8Array> | null,
  onDelta: (chunk: string) => void
): Promise<string> {
  let text = "";

  for await (const payload of sseEvents(body)) {
    if (payload === "[DONE]") break;

    let event: {
      choices?: Array<{ delta?: { content?: string } }>;
      error?: { message?: string };
    };
    try {
      event = JSON.parse(payload);
    } catch {
      // OpenRouter emits `: OPENROUTER PROCESSING` keep-alive comments, which
      // never reach here, but other gateways send stray non-JSON lines that do.
      continue;
    }

    if (event.error) {
      throw new Error(`Stream error: ${event.error.message || "unknown"}`);
    }

    const chunk = event.choices?.[0]?.delta?.content;
    if (chunk) {
      text += chunk;
      onDelta(chunk);
    }
  }

  return text;
}
