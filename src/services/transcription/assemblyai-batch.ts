import { pcmToWav } from "./wav";

/**
 * Batch transcription via the AssemblyAI REST API.
 *
 * The push-to-talk pipeline hands over one complete PCM recording rather than a
 * live stream, so the streaming provider in `assemblyai.ts` does not fit it.
 * This is the upload → submit → poll flow instead.
 */

const BASE = "https://api.assemblyai.com/v2";

/** How long to wait for a transcript before giving up. */
const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;

export async function transcribeAssemblyAI(
  pcmBuffer: Buffer,
  apiKey: string
): Promise<string> {
  if (!apiKey) {
    throw new Error("AssemblyAI API key is not set.");
  }

  // 1. Upload the audio. AssemblyAI reads the container, so send a real WAV.
  const wav = pcmToWav(pcmBuffer);
  const uploadRes = await fetch(`${BASE}/upload`, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array(wav),
  });

  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    throw new Error(`AssemblyAI upload failed (${uploadRes.status}): ${body}`);
  }

  const { upload_url } = (await uploadRes.json()) as { upload_url: string };

  // 2. Submit for transcription.
  const submitRes = await fetch(`${BASE}/transcript`, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      audio_url: upload_url,
      // Evolute's queries are short commands; the default model is plenty and
      // punctuation makes the transcript read better in the chat window.
      punctuate: true,
      format_text: true,
    }),
  });

  if (!submitRes.ok) {
    const body = await submitRes.text();
    throw new Error(`AssemblyAI submit failed (${submitRes.status}): ${body}`);
  }

  const { id } = (await submitRes.json()) as { id: string };

  // 3. Poll until the job finishes.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const pollRes = await fetch(`${BASE}/transcript/${id}`, {
      headers: { Authorization: apiKey },
    });

    if (!pollRes.ok) {
      const body = await pollRes.text();
      throw new Error(`AssemblyAI poll failed (${pollRes.status}): ${body}`);
    }

    const data = (await pollRes.json()) as {
      status: string;
      text?: string;
      error?: string;
    };

    if (data.status === "completed") {
      return (data.text || "").trim();
    }
    if (data.status === "error") {
      throw new Error(`AssemblyAI transcription error: ${data.error}`);
    }
  }

  throw new Error(
    `AssemblyAI transcription timed out after ${POLL_TIMEOUT_MS / 1000}s.`
  );
}
