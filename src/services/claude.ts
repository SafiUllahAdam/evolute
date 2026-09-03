import { SettingsStore } from "../main/settings";
import { streamAnthropicText } from "./sse";
import {
  ChatQueryParams as ClaudeQueryParams,
  ChatResponse as ClaudeResponse,
  POINTING_SYSTEM_PROMPT as SYSTEM_PROMPT,
  buildScreenContext,
  buildDocumentSystemBlock,
  buildMessages,
} from "./pointing-prompt";

export class ClaudeService {
  private settings: SettingsStore;

  constructor(settings: SettingsStore) {
    this.settings = settings;
  }

  async query(params: ClaudeQueryParams): Promise<ClaudeResponse> {
    const apiKey = this.settings.get("anthropicApiKey");
    const useProxy = this.settings.get("useProxy");
    const proxyUrl = this.settings.get("proxyUrl");
    const model = this.settings.get("claudeModel");

    const baseUrl = useProxy && proxyUrl
      ? proxyUrl
      : "https://api.anthropic.com";

    // Build message content with images
    const userContent: Array<Record<string, unknown>> = [];

    // Add screenshots as images
    for (const screenshot of params.screenshots) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: screenshot.data,
        },
      });
    }

    // Add screen context
    userContent.push({ type: "text", text: buildScreenContext(params) });

    const messages = buildMessages(params, userContent);

    // The system prompt goes out as blocks rather than a plain string so the
    // attached documents can carry a cache breakpoint. `cache_control` on the
    // last block caches everything ahead of it as well, so this single marker
    // covers the pointing prompt and the documents together: every later turn
    // in the session re-reads that whole prefix at a fraction of the input
    // price instead of paying full rate for tens of thousands of document
    // tokens on every question.
    //
    // The cache entry expires after roughly five minutes of inactivity, so a
    // long pause between questions pays the write cost again. Still far
    // cheaper than not caching at all. No breakpoint when there are no
    // documents: the pointing prompt on its own sits near Anthropic's minimum
    // cacheable size, so marking it buys nothing.
    const system: Array<Record<string, unknown>> = [
      { type: "text", text: SYSTEM_PROMPT },
    ];
    if (params.documents) {
      system.push({
        type: "text",
        text: buildDocumentSystemBlock(params.documents),
        cache_control: { type: "ephemeral" },
      });
    }

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system,
        messages,
        stream: !!params.onDelta,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Claude API error (${response.status}): ${error}`);
    }

    if (params.onDelta) {
      return { text: await streamAnthropicText(response.body, params.onDelta) };
    }

    const data = await response.json() as {
      content: Array<{ type: string; text?: string }>;
    };
    const text = data.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    return { text };
  }

  /**
   * Second-pass pointing refinement. Given a cropped patch of the original
   * screenshot and a label, ask Claude to return the exact pixel center of
   * the element within that crop. Returns null if Claude can't find it.
   */
  async refinePoint(
    cropBase64: string,
    cropWidth: number,
    cropHeight: number,
    label: string
  ): Promise<{ x: number; y: number } | null> {
    const apiKey = this.settings.get("anthropicApiKey");
    const useProxy = this.settings.get("useProxy");
    const proxyUrl = this.settings.get("proxyUrl");
    const model = this.settings.get("claudeModel");
    const baseUrl = useProxy && proxyUrl ? proxyUrl : "https://api.anthropic.com";

    const system =
      `You are a precise UI pointing tool. You receive a zoomed crop of a screenshot and a description of a UI element. ` +
      `Return ONLY "x,y" - integer pixel coordinates of the exact visual center of the element matching the description. ` +
      `CRITICAL: the crop may contain visually similar neighboring elements (e.g. a Like button next to a Dislike button, ` +
      `or several tabs side by side). Return the EXACT element described, NOT an adjacent look-alike. ` +
      `Aim for the center of the element's icon or main hit target. ` +
      `If the element is not visible in the crop, return "none". No other text, no prose, no units.`;

    const userContent = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: cropBase64 },
      },
      {
        type: "text",
        text:
          `Crop image size: ${cropWidth}x${cropHeight} pixels (origin 0,0 = top-left).\n` +
          `Target element: "${label}"\n` +
          `Return the pixel center as "x,y" only.`,
      },
    ];

    try {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 32,
          system,
          messages: [{ role: "user", content: userContent }],
        }),
      });

      if (!response.ok) return null;

      const data = (await response.json()) as {
        content: Array<{ type: string; text?: string }>;
      };
      const text = data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text || "")
        .join("")
        .trim();

      const match = text.match(/(\d+)\s*,\s*(\d+)/);
      if (!match) return null;
      return { x: parseInt(match[1], 10), y: parseInt(match[2], 10) };
    } catch {
      return null;
    }
  }
}
