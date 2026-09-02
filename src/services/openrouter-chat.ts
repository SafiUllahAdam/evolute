import { SettingsStore } from "../main/settings";
import {
  ChatQueryParams,
  ChatResponse,
  POINTING_SYSTEM_PROMPT,
  buildScreenContext,
} from "./pointing-prompt";

/**
 * OpenRouter chat service - OpenAI-compatible API that routes to 300+ models.
 * Supports Claude, GPT, Llama, Mistral, Gemini, and more through one endpoint.
 */
export class OpenRouterChatService {
  private settings: SettingsStore;

  constructor(settings: SettingsStore) {
    this.settings = settings;
  }

  async query(params: ChatQueryParams): Promise<ChatResponse> {
    const apiKey = this.settings.get("openrouterApiKey");
    const model = this.settings.get("openrouterModel");

    // Build user message content with images (OpenAI vision format)
    const userContent: Array<Record<string, unknown>> = [];

    for (const screenshot of params.screenshots) {
      userContent.push({
        type: "image_url",
        image_url: {
          url: `data:image/jpeg;base64,${screenshot.data}`,
        },
      });
    }

    userContent.push({ type: "text", text: buildScreenContext(params) });

    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: POINTING_SYSTEM_PROMPT },
    ];

    for (const entry of params.conversationHistory) {
      if (entry.role === "user" && entry.content === params.transcript) {
        messages.push({ role: "user", content: userContent });
      } else {
        messages.push({ role: entry.role, content: entry.content });
      }
    }

    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://github.com/tekram/clicky-windows",
          "X-Title": "Evolute Windows",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          messages,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const text = data.choices[0]?.message?.content || "";
    return { text };
  }
}
