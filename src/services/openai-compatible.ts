import { SettingsStore } from "../main/settings";
import {
  ChatQueryParams,
  ChatResponse,
  POINTING_SYSTEM_PROMPT,
  buildScreenContext,
} from "./pointing-prompt";

/**
 * One settings slot for an OpenAI-compatible vision endpoint.
 *
 * Evolute ships two of these (see SLOTS below): a free one for testing and a
 * paid one for daily use. They differ only in which settings keys they read,
 * so the request code is shared.
 */
export interface EndpointSlot {
  /** Human-readable name, used in error messages. */
  label: string;
  apiKeyField: "groqApiKey" | "glmApiKey";
  baseUrlField: "groqBaseUrl" | "glmBaseUrl";
  modelField: "groqModel" | "glmModel";
  /** Used when the slot's own base URL setting is blank. */
  defaultBaseUrl: string;
}

export const SLOTS: Record<"groq" | "glm", EndpointSlot> = {
  // Free tier, generous rate limits - the "does my setup work at all" slot.
  groq: {
    label: "Groq",
    apiKeyField: "groqApiKey",
    baseUrlField: "groqBaseUrl",
    modelField: "groqModel",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
  },
  // Paid but cheap. Defaults to Z.ai (GLM), but the base URL is free-text so
  // the same slot covers Zhipu, DashScope/Qwen, DeepSeek, Moonshot, a local
  // vLLM/Ollama server, or any other gateway exposing /chat/completions.
  glm: {
    label: "GLM",
    apiKeyField: "glmApiKey",
    baseUrlField: "glmBaseUrl",
    modelField: "glmModel",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
  },
};

/**
 * Chat service for any OpenAI-compatible `/chat/completions` endpoint.
 *
 * The model must be a vision model: Evolute sends a screenshot with every query,
 * and a text-only model will either reject the request or silently ignore the
 * images and point at nothing.
 */
export class OpenAICompatibleChatService {
  private settings: SettingsStore;
  private slot: EndpointSlot;

  constructor(settings: SettingsStore, slot: EndpointSlot) {
    this.settings = settings;
    this.slot = slot;
  }

  async query(params: ChatQueryParams): Promise<ChatResponse> {
    const { label, apiKeyField, baseUrlField, modelField, defaultBaseUrl } = this.slot;

    const apiKey = this.settings.get(apiKeyField);
    const model = this.settings.get(modelField);
    const configuredUrl = this.settings.get(baseUrlField).trim();
    const baseUrl = (configuredUrl || defaultBaseUrl).replace(/\/+$/, "");

    if (!model) {
      throw new Error(
        `${label} model is not set. Enter a vision-capable model id in Settings.`
      );
    }

    // OpenAI vision format - screenshots as inline data URIs.
    const userContent: Array<Record<string, unknown>> = [];

    for (const screenshot of params.screenshots) {
      userContent.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${screenshot.data}` },
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

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // Local servers (Ollama, vLLM without auth) accept an empty key.
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`${label} API error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const text = data.choices?.[0]?.message?.content || "";
    return { text };
  }
}
