import { TranscriptionProvider } from "./interface";
import WebSocket from "ws";

/**
 * AssemblyAI real-time streaming transcription (Universal-Streaming, v3).
 *
 * The old `/v2/realtime` endpoints this used to call now return 404 - that API
 * was retired. v3 differs in three ways that matter here:
 *   - the temporary token comes from a GET on streaming.assemblyai.com
 *   - audio frames are sent as raw binary, not base64 wrapped in JSON
 *   - results arrive as "Turn" messages instead of Partial/FinalTranscript
 */
export class AssemblyAIProvider implements TranscriptionProvider {
  private apiKey: string;
  private ws: WebSocket | null = null;
  private partialCallback: ((text: string) => void) | null = null;
  private finalCallback: ((text: string) => void) | null = null;
  /**
   * Completed turns, keyed by turn_order. With format_turns enabled each turn
   * arrives twice - unformatted first, then formatted - so keying by order
   * lets the formatted version overwrite rather than duplicate the text.
   */
  private turns = new Map<number, string>();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async start(): Promise<void> {
    if (!this.apiKey) {
      throw new Error("AssemblyAI API key is not set.");
    }

    const tokenResponse = await fetch(
      "https://streaming.assemblyai.com/v3/token?expires_in_seconds=480",
      { headers: { Authorization: this.apiKey } }
    );

    if (!tokenResponse.ok) {
      const body = await tokenResponse.text();
      throw new Error(
        `AssemblyAI token error (${tokenResponse.status}): ${body}`
      );
    }

    const { token } = (await tokenResponse.json()) as { token: string };

    const params = new URLSearchParams({
      sample_rate: "16000",
      encoding: "pcm_s16le",
      format_turns: "true",
      token,
    });

    this.ws = new WebSocket(
      `wss://streaming.assemblyai.com/v3/ws?${params.toString()}`
    );

    this.ws.on("message", (data: WebSocket.Data) => {
      let msg: {
        type?: string;
        turn_order?: number;
        transcript?: string;
        end_of_turn?: boolean;
        error?: string;
      };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type !== "Turn" || !msg.transcript) return;

      if (msg.end_of_turn) {
        this.turns.set(msg.turn_order ?? this.turns.size, msg.transcript);
        this.finalCallback?.(msg.transcript);
      } else {
        this.partialCallback?.(msg.transcript);
      }
    });

    return new Promise((resolve, reject) => {
      this.ws!.on("open", () => resolve());
      this.ws!.on("error", (err) => reject(err));
    });
  }

  sendAudio(chunk: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      // v3 takes raw PCM frames on the socket.
      this.ws.send(chunk);
    }
  }

  async stop(): Promise<string> {
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "Terminate" }));
        // Give the server a moment to flush the last formatted turn before
        // tearing the socket down, but never hang the voice pipeline on it.
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, 2000);
          ws.once("close", done);
        });
      }
      ws.close();
    }

    const result = [...this.turns.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, text]) => text)
      .join(" ")
      .trim();
    this.turns.clear();
    return result;
  }

  onPartialTranscript(callback: (text: string) => void): void {
    this.partialCallback = callback;
  }

  onFinalTranscript(callback: (text: string) => void): void {
    this.finalCallback = callback;
  }
}
