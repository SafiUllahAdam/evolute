import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

interface SettingsSchema {
  // API Keys (BYOK)
  anthropicApiKey: string;
  openaiApiKey: string;
  openrouterApiKey: string;
  // Two OpenAI-compatible slots: groq = free tier for testing,
  // glm = cheap paid endpoint for daily use (Z.ai/Zhipu, DashScope, ...).
  groqApiKey: string;
  glmApiKey: string;
  assemblyaiApiKey: string;
  elevenlabsApiKey: string;

  // Base URLs for the two OpenAI-compatible slots. Blank = the built-in
  // default for that slot (see SLOTS in services/openai-compatible.ts).
  groqBaseUrl: string;
  glmBaseUrl: string;

  // Optional proxy (for non-BYOK / org deployments)
  proxyUrl: string;
  useProxy: boolean;

  // Transcription
  transcriptionProvider: "assemblyai" | "openai" | "whisper-local";

  // TTS
  ttsEnabled: boolean;
  ttsProvider: "elevenlabs" | "openai" | "local";
  elevenlabsVoiceId: string;
  openaiTtsVoice: string;

  // Hotkey
  pushToTalkHotkey: string;

  // AI Provider
  aiProvider: "anthropic" | "openai" | "openrouter" | "groq" | "glm";
  claudeModel: string;
  openaiModel: string;
  openrouterModel: string;
  groqModel: string;
  glmModel: string;

  // UI
  alwaysOnTop: boolean;
  cursorBuddyEnabled: boolean;

  // HIPAA
  hipaaMode: boolean;
}

const defaults: SettingsSchema = {
  anthropicApiKey: "",
  openaiApiKey: "",
  openrouterApiKey: "",
  groqApiKey: "",
  glmApiKey: "",
  assemblyaiApiKey: "",
  elevenlabsApiKey: "",
  groqBaseUrl: "https://api.groq.com/openai/v1",
  glmBaseUrl: "https://api.z.ai/api/paas/v4",
  proxyUrl: "",
  useProxy: false,
  transcriptionProvider: "assemblyai",
  ttsEnabled: true,
  ttsProvider: "local",
  elevenlabsVoiceId: "kPzsL2i3teMYv0FxEYQ6",
  openaiTtsVoice: "alloy",
  pushToTalkHotkey: "Ctrl+Shift",
  alwaysOnTop: false,
  cursorBuddyEnabled: true,
  aiProvider: "anthropic",
  claudeModel: "claude-sonnet-4-5-20250929",
  openaiModel: "gpt-4o",
  openrouterModel: "anthropic/claude-sonnet-4-5",
  groqModel: "meta-llama/llama-4-scout-17b-16e-instruct",
  glmModel: "glm-4.5v",
  hipaaMode: false,
};

/**
 * Simple JSON file settings store. Avoids electron-store ESM issues.
 */
export class SettingsStore {
  private data: SettingsSchema;
  private filePath: string;

  constructor() {
    const userDataPath = app.isReady()
      ? app.getPath("userData")
      : path.join(
          process.env.APPDATA || process.env.HOME || ".",
          "evolute-windows"
        );

    this.filePath = path.join(userDataPath, "settings.json");
    this.data = { ...defaults };

    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<SettingsSchema>;
        this.data = { ...defaults, ...parsed };
      }
    } catch {
      // Use defaults on any read error
    }
  }

  get<K extends keyof SettingsSchema>(
    key: K,
    fallback?: SettingsSchema[K]
  ): SettingsSchema[K] {
    const val = this.data[key];
    if (val === undefined && fallback !== undefined) return fallback;
    return val;
  }

  set<K extends keyof SettingsSchema>(
    key: K,
    value: SettingsSchema[K]
  ): void {
    this.data[key] = value;
    this.save();
  }

  getAll(): SettingsSchema {
    return { ...this.data };
  }

  isConfigured(): boolean {
    if (this.get("useProxy") && this.get("proxyUrl")) {
      return true;
    }
    switch (this.get("aiProvider")) {
      case "openai":
        return !!this.get("openaiApiKey");
      case "openrouter":
        return !!this.get("openrouterApiKey");
      case "groq":
        return !!this.get("groqApiKey") && !!this.get("groqModel");
      // A self-hosted endpoint may need no key, so the model is what counts.
      case "glm":
        return !!this.get("glmModel") &&
          (!!this.get("glmApiKey") || !!this.get("glmBaseUrl"));
      default:
        return !!this.get("anthropicApiKey");
    }
  }

  isHipaaMode(): boolean {
    return this.get("hipaaMode");
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch {
      // Silent fail on write error
    }
  }
}
