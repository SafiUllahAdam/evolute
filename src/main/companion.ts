import { BrowserWindow } from "electron";
import { ScreenCapture, ScreenshotResult, cropScreenshotRegion } from "./screenshot";
import { SettingsStore } from "./settings";
import { ProjectStore, ConversationEntry, SessionMeta } from "./project-store";
import { ClaudeService } from "../services/claude";
import { OpenAIChatService } from "../services/openai-chat";
import { OpenRouterChatService } from "../services/openrouter-chat";
import { OpenAICompatibleChatService, SLOTS } from "../services/openai-compatible";
import {
  TranscriptionProvider,
  createTranscriptionProvider,
} from "../services/transcription/interface";
import { createTTSProvider } from "../services/tts/interface";
import { SpeechQueue } from "../services/tts/speech-queue";

interface AIProvider {
  query(params: {
    transcript: string;
    screenshots: ScreenshotResult[];
    cursorPosition: { x: number; y: number };
    conversationHistory: ConversationEntry[];
    documents: string;
    onDelta: (chunk: string) => void;
  }): Promise<{ text: string }>;
}

const MAX_CONVERSATION_HISTORY = 20;

/**
 * Central orchestrator - mirrors CompanionManager.swift from macOS version.
 *
 * Flow: voice → screenshot → ai (anthropic or openai) → tts → overlay pointing
 */
export class CompanionManager {
  private settings: SettingsStore;
  private screenCapture: ScreenCapture;
  private transcription: TranscriptionProvider;
  private conversationHistory: ConversationEntry[] = [];
  private overlayWindows: BrowserWindow[] = [];
  private projects: ProjectStore;
  /** The reply currently being spoken, kept so a new question can cut it off. */
  private speech: SpeechQueue | null = null;

  constructor(
    settings: SettingsStore,
    overlayWindows: BrowserWindow[],
    projects: ProjectStore
  ) {
    this.settings = settings;
    this.screenCapture = new ScreenCapture();
    this.transcription = createTranscriptionProvider(settings);
    this.overlayWindows = overlayWindows;
    this.projects = projects;
    // Pick the conversation back up where the last run left it. Text only:
    // the screenshots that went with those turns are long stale, and resending
    // them would be both expensive and misleading about the current screen.
    this.conversationHistory = projects.getHistory();
  }

  private getAIProvider(): AIProvider {
    const provider = this.settings.get("aiProvider");
    if (provider === "openai") {
      return new OpenAIChatService(this.settings);
    }
    if (provider === "openrouter") {
      return new OpenRouterChatService(this.settings);
    }
    if (provider === "groq" || provider === "glm") {
      return new OpenAICompatibleChatService(this.settings, SLOTS[provider]);
    }
    return new ClaudeService(this.settings);
  }

  /**
   * Pushes the reply to the chat window as it is generated.
   *
   * `start` and `end` bracket a reply so the window knows when to open a fresh
   * message bubble and when to re-render it as markdown; `delta` carries each
   * fragment in between.
   */
  private broadcastStream(event: { type: "start" | "delta" | "end"; text?: string }): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("chat:stream", event);
      }
    }
  }

  private broadcastStage(stage: string, label: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("companion:stage", { stage, label });
      }
    }
  }

  /**
   * Process a user query: capture screen, send to AI, speak response.
   */
  async processQuery(transcript: string): Promise<string> {
    try {
    // 1. Capture screenshots
    this.broadcastStage("capturing", "Reading screen...");
    const screenshots = await this.screenCapture.captureAllScreens();
    const cursorPos = this.screenCapture.getCursorPosition();

    // 2. Send to AI provider with conversation history
    this.conversationHistory.push({ role: "user", content: transcript });

    // A new question cancels whatever the previous answer was still saying.
    if (this.speech) this.speech.stop();
    this.speech = null;

    let speech: SpeechQueue | null = null;
    if (this.settings.get("ttsEnabled")) {
      try {
        speech = new SpeechQueue(createTTSProvider(this.settings));
        this.speech = speech;
      } catch (err: unknown) {
        // A misconfigured voice must not stop the answer being written out.
        console.warn(
          "TTS provider creation failed:",
          err instanceof Error ? err.message : err
        );
      }
    }

    this.broadcastStage("querying", "Analyzing...");
    this.broadcastStream({ type: "start" });

    const ai = this.getAIProvider();
    let firstDelta = true;
    const response = await ai.query({
      transcript,
      screenshots,
      cursorPosition: cursorPos,
      conversationHistory: this.conversationHistory,
      documents: this.projects.getDocumentContext(),
      onDelta: (chunk) => {
        if (firstDelta) {
          firstDelta = false;
          this.broadcastStage("responding", "Responding...");
        }
        this.broadcastStream({ type: "delta", text: chunk });
        if (speech) speech.push(chunk);
      },
    });

    this.broadcastStream({ type: "end" });

    // Flushed here rather than after the pointing work below: refinement is a
    // whole extra round-trip, and the closing sentence should not wait on it.
    if (speech) {
      speech.flush().catch(() => {
        // Already reported per sentence inside the queue.
      });
    }

    this.conversationHistory.push({ role: "assistant", content: response.text });

    // Trim history
    if (this.conversationHistory.length > MAX_CONVERSATION_HISTORY * 2) {
      this.conversationHistory = this.conversationHistory.slice(-MAX_CONVERSATION_HISTORY * 2);
    }

    // Persist after every completed turn rather than on quit: this is a tray
    // app that is usually killed rather than closed, and an exit handler that
    // never runs saves nothing.
    this.projects.saveHistory(this.conversationHistory);

    // 3a. Parse raw POINT tags (still in image-pixel space).
    const rawTags = this.parseRawPointTags(response.text);
    console.log("[Evolute] AI response:", response.text);
    console.log("[Evolute] Raw POINT tags:", JSON.stringify(rawTags));

    // 3b. Second-pass refinement: only Claude for now.
    //     For each tag, crop ~400px around the estimated point and ask the
    //     model to return the precise pixel center. Falls back to the raw
    //     tag if anything goes wrong.
    const aiProviderName = this.settings.get("aiProvider");
    let refinedTags = rawTags;
    if (aiProviderName === "anthropic" && rawTags.length > 0) {
      this.broadcastStage("refining", "Refining points...");
      const claude = new ClaudeService(this.settings);
      refinedTags = await Promise.all(
        rawTags.map(async (tag) => {
          const shot = screenshots[tag.screen] || screenshots[0];
          if (!shot) return tag;
          try {
            // 300 imageDim px - small enough to reduce ambiguity with
            // neighboring similar elements (e.g. like/dislike), large enough
            // to give context. At native DPI this is a much sharper patch
            // than cropping the downsampled pass-1 image.
            const crop = cropScreenshotRegion(shot, tag.x, tag.y, 300);
            const refined = await claude.refinePoint(
              crop.data,
              crop.claudeSize.w,
              crop.claudeSize.h,
              tag.label
            );
            if (refined) {
              // Refined coords live in native crop-pixel space. Map back to
              // imageDimensions (pass-1) space so later scaling to display
              // px works consistently.
              const imgX = crop.origin.x + refined.x / crop.pxPerImageDim;
              const imgY = crop.origin.y + refined.y / crop.pxPerImageDim;
              console.log(
                `[Evolute] Refined "${tag.label}": (${tag.x},${tag.y}) → (${Math.round(imgX)},${Math.round(imgY)})`
              );
              return { ...tag, x: Math.round(imgX), y: Math.round(imgY) };
            }
          } catch (err) {
            console.warn(
              `[Evolute] Refinement failed for "${tag.label}":`,
              err instanceof Error ? err.message : err
            );
          }
          return tag;
        })
      );
    }

    // 3c. Scale image-pixel coords to display-pixel coords for the overlay.
    const pointTags = refinedTags.map((tag) => {
      const shot = screenshots[tag.screen] || screenshots[0];
      if (!shot) return tag;
      const scaleX = shot.bounds.width / shot.imageDimensions.width;
      const scaleY = shot.bounds.height / shot.imageDimensions.height;
      return {
        ...tag,
        x: Math.round(tag.x * scaleX),
        y: Math.round(tag.y * scaleY),
      };
    });
    console.log("[Evolute] Final POINT tags:", JSON.stringify(pointTags));
    console.log("[Evolute] Overlay windows:", this.overlayWindows.length);
    if (pointTags.length > 0 && this.overlayWindows.length > 0) {
      // Route each tag to the overlay for its target display. Coordinates
      // are already in that display's local CSS space (0..bounds.width).
      const byScreen = new Map<number, typeof pointTags>();
      for (const tag of pointTags) {
        const list = byScreen.get(tag.screen) || [];
        list.push(tag);
        byScreen.set(tag.screen, list);
      }
      for (const [screenIdx, tags] of byScreen) {
        if (screenIdx < 0 || screenIdx >= this.overlayWindows.length) {
          console.warn(
            `[Evolute] POINT tag screen=${screenIdx} is out of range (have ${this.overlayWindows.length} overlay windows); routing to primary display.`
          );
        }
        const win = this.overlayWindows[screenIdx] || this.overlayWindows[0];
        if (win && !win.isDestroyed()) {
          win.webContents.send("overlay:point", tags);
        }
      }
    }

    return response.text;
    } finally {
      this.broadcastStage("done", "");
    }
  }

  private parseRawPointTags(
    text: string
  ): Array<{ x: number; y: number; label: string; screen: number }> {
    const regex = /\[POINT:(\d+),(\d+):([^:]+):screen(\d+)\]/g;
    const tags: Array<{ x: number; y: number; label: string; screen: number }> = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      tags.push({
        x: parseInt(match[1], 10),
        y: parseInt(match[2], 10),
        label: match[3],
        screen: parseInt(match[4], 10),
      });
    }

    return tags;
  }

  /** Cuts off any reply still being spoken. Used on quit. */
  stopSpeaking(): void {
    if (this.speech) {
      this.speech.stop();
      this.speech = null;
    }
  }

  /** Transcript of the running conversation, for the chat window to replay. */
  getHistory(): ConversationEntry[] {
    return this.conversationHistory.map((entry) => ({ ...entry }));
  }

  /** Empties the open chat. Attached documents are deliberately kept. */
  clearHistory(): void {
    this.stopSpeaking();
    this.conversationHistory = [];
    this.projects.clearHistory();
  }

  listSessions(): SessionMeta[] {
    return this.projects.listSessions();
  }

  activeSessionId(): string {
    return this.projects.activeSessionId();
  }

  /** Opens a new chat. Documents stay attached across all chats. */
  newSession(): SessionMeta {
    this.stopSpeaking();
    const meta = this.projects.newSession();
    this.conversationHistory = [];
    return meta;
  }

  /** Reopens an earlier chat and continues it. */
  switchSession(id: string): ConversationEntry[] {
    this.stopSpeaking();
    this.conversationHistory = this.projects.switchSession(id);
    return this.getHistory();
  }

  deleteSession(id: string): { sessions: SessionMeta[]; activeId: string } {
    this.stopSpeaking();
    const result = this.projects.deleteSession(id);
    if (result.switched) {
      this.conversationHistory = this.projects.getHistory();
    }
    return { sessions: result.sessions, activeId: result.activeId };
  }
}
