# eVolutɘ

**AI screen companion for Windows.** Ask about whatever is on your screen, by voice or text, and get an answer that points at the thing it is talking about.

## What is eVolutɘ?

A tray-resident assistant that can see your screen. Instead of describing your
problem to a chatbot, you ask out loud while looking at it: "what does this
error mean", "where is the setting for this", "which button submits the form".
eVolutɘ captures the screen at that moment, answers in the chat window, speaks
the answer aloud, and drops a glowing purple **V** on the element it means.

It only looks when you ask. Nothing is captured in the background.

## How it works

1. Press `Ctrl+Shift+Space` and speak. Stop talking and it sends itself after a
   two second pause; press again to cut it off early. (Or just type in the chat
   window; voice is optional.)
2. Your speech is transcribed and the screen is captured at that instant.
3. Both go to a vision model, which replies in words and, where relevant, with
   coordinates for what it is describing.
4. The answer streams into the chat as it is written, and each sentence is
   spoken as soon as it is finished rather than after the whole reply.
   Coordinates become an on-screen **V** that lands on the element for a few
   seconds.

## Key capabilities

**Voice and screen understanding.** Push-to-talk transcription with a choice of
engines, paired with a full-resolution screen capture so the model reads what
you are actually looking at, including small text. Recording ends on its own
when you stop speaking.

**Answers that start immediately.** Replies stream in as the model writes them
and are spoken sentence by sentence, so the first words arrive in a second or
two instead of after the whole answer is finished.

**Visual guidance.** Answers can point. The model emits inline `[POINT]` tags
that become an animated marker on the real screen, across multiple monitors.
With Anthropic models a second refinement pass re-crops each point at native
resolution to land accurately on dense UI; other providers use single-pass
coordinates, which are close but less exact.

**Cursor companion.** A small glowing purple V rides just off your mouse
pointer so you can see the app is live. Toggleable.

**Project context.** Attach your README, docs and source files once and every
answer is informed by them, so you never re-explain the project. Files are held
in the system prompt and cached between questions on Anthropic, which makes
re-sending them cheap. Drag them onto the chat window or use the file picker.
Files that commonly hold secrets, such as `.env`, are refused.

**Stays out of the way.** Lives in the system tray, optional always-on-top chat
window, remembers the last 20 exchanges of a conversation and picks the thread
back up after a restart.

## Supported AI models

| Provider | Notes |
| --- | --- |
| Anthropic | Full accuracy, including two-pass point refinement |
| OpenAI | Vision chat completions |
| OpenRouter | One key, many models, including free tiers |
| Any OpenAI-compatible endpoint | Two configurable slots for self-hosted or third-party APIs |

Transcription: AssemblyAI, OpenAI Whisper, or whisper.cpp running locally.
Speech: Windows SAPI (offline), OpenAI, or ElevenLabs.

## Privacy

Screens are captured only in response to an explicit request, never on a timer
or in the background.

Attached project files are read from disk and sent to your chosen model with
each question. Nothing is attached unless you attach it.

Choosing local Whisper and Windows SAPI keeps audio and spoken replies entirely
on the machine; only the model call leaves it. **HIPAA mode** enforces that
combination in one switch. An optional proxy can front the model call.

API keys are stored in plain text at `%APPDATA%\evolute-windows\settings.json`.
That is reasonable for a personal tool on your own machine and not appropriate
for a shared or distributed build.

## Installation

Build the installer, then run `Evolute-Setup.exe`. It installs per user, so
there is no admin prompt.

```bash
npm install
npx tsc
npm run make
```

The installer is written to `<build root>/make/squirrel.windows/x64/Evolute-Setup.exe`,
where the build root defaults to `S:/evolute-build/out` and can be overridden
with the `EVOLUTE_OUT_DIR` environment variable.

The build is unsigned, so Windows SmartScreen will warn on first run: choose
**More info > Run anyway**.

To run from source instead:

```bash
npm install
npx tsc
npm run dev
```

> `npm run dev` does not compile TypeScript. Run `npx tsc` first and after every
> source change, or keep `npx tsc --watch` in a second terminal.

Then open **Settings** from the tray icon and add an API key for whichever
provider you want to use.

## Roadmap

- Point refinement for non-Anthropic providers
- Prompt caching for the non-Anthropic providers
- Signed builds, to drop the SmartScreen warning

## Architecture

```
src/
  main/         Electron main process: windows, tray, hotkey, orchestration
  services/     Model, transcription and speech providers
  preload/      Context bridge
  renderer/     Chat, settings, and the transparent overlay
```

The pointing pipeline moves between three coordinate spaces - the downsampled
image sent to the model, the native-resolution crop used for refinement, and
the overlay's display pixels. Every conversion has to be explicit; that is the
part most likely to break if you change it.

## License

MIT
