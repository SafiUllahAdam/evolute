import { TTSProvider } from "./interface";

/**
 * Speaks a streaming reply sentence by sentence instead of waiting for all of
 * it.
 *
 * The old behaviour handed the finished answer to the TTS provider in one
 * call, so nothing was spoken until generation had completely finished. With
 * a local voice that meant the reply was on screen for several seconds before
 * it started being read out. Here each complete sentence is spoken as soon as
 * it arrives, and the rest of the reply keeps generating while it plays.
 */

const POINT_TAG = /\[POINT:[^\]]+\]/g;

/**
 * Shortest fragment worth speaking on its own. Low on purpose: an opening
 * "Yes." getting out immediately is the whole point, and anything shorter is
 * usually a decimal point rather than a sentence.
 */
const MIN_SPEAK_CHARS = 6;

/**
 * Splits off whatever is safely speakable, leaving the remainder buffered.
 *
 * Two things must never be cut through: a POINT tag that has not been closed
 * yet (the voice would read "bracket POINT nine hundred twenty"), and a
 * decimal point, which looks exactly like a full stop unless the character
 * after it is checked.
 */
export function extractSpeakable(buffer: string): { speak: string; rest: string } {
  const lastOpen = buffer.lastIndexOf("[");
  const lastClose = buffer.lastIndexOf("]");
  // A "[" after the final "]" means a tag is still being streamed.
  const limit = lastOpen > lastClose ? lastOpen : buffer.length;

  let cut = -1;
  for (let i = limit - 1; i >= 0; i--) {
    const ch = buffer[i];
    if (ch === "\n") {
      cut = i + 1;
      break;
    }
    if (ch === "." || ch === "!" || ch === "?") {
      const next = buffer[i + 1];
      // End of a sentence only when whitespace follows, or nothing does but we
      // already know more text is coming after it (the tag boundary above).
      if (next === undefined || /\s/.test(next)) {
        cut = i + 1;
        break;
      }
    }
  }

  if (cut < MIN_SPEAK_CHARS) return { speak: "", rest: buffer };
  return { speak: buffer.slice(0, cut), rest: buffer.slice(cut) };
}

export class SpeechQueue {
  private tts: TTSProvider;
  private buffer = "";
  private stopped = false;
  /**
   * Utterances are chained rather than fired in parallel: every provider here
   * plays audio on the machine's one output, and LocalTTS additionally kills
   * its predecessor on each `speak`, so overlapping calls would talk over
   * themselves and drop sentences.
   */
  private chain: Promise<void> = Promise.resolve();

  constructor(tts: TTSProvider) {
    this.tts = tts;
  }

  /** Feed streamed text. Complete sentences are spoken as they appear. */
  push(chunk: string): void {
    if (this.stopped) return;
    this.buffer += chunk;
    const { speak, rest } = extractSpeakable(this.buffer);
    this.buffer = rest;
    if (speak) this.enqueue(speak);
  }

  /** Speak the trailing fragment. Resolves once everything has been said. */
  flush(): Promise<void> {
    if (!this.stopped && this.buffer) this.enqueue(this.buffer);
    this.buffer = "";
    return this.chain;
  }

  /** Cut the reply off mid-sentence, for a new question or a quit. */
  stop(): void {
    this.stopped = true;
    this.buffer = "";
    try {
      this.tts.stop();
    } catch {
      // Nothing playing.
    }
  }

  private enqueue(text: string): void {
    // Removing a tag that sat mid-sentence leaves a gap in front of the
    // punctuation it preceded ("Click Save ."), which reads as a stumble.
    const clean = text
      .replace(POINT_TAG, "")
      .replace(/\s+/g, " ")
      .replace(/\s+([.,!?;:])/g, "$1")
      .trim();
    if (!clean) return;

    this.chain = this.chain
      .then(() => (this.stopped ? undefined : this.tts.speak(clean)))
      .catch((err: unknown) => {
        // One failed sentence must not break the rest of the reply, and TTS is
        // never worth failing an answered query over.
        console.warn("TTS sentence failed (non-fatal):", err instanceof Error ? err.message : err);
      });
  }
}
