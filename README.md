# Evolute Windows

AI-powered screen companion for Windows. See your screen, hear your voice, point at answers.

## What it does

- **Sees your screen** - captures screenshots and sends them to Claude with vision
- **Hears you** - push-to-talk voice input with real-time transcription
- **Speaks back** - text-to-speech responses via ElevenLabs, OpenAI, or Windows SAPI
- **Points at things** - animated cursor overlay that highlights UI elements Claude references
- **Cursor buddy** - glowing purple V that rides alongside your mouse (toggleable)
- **Always on top** - optional pinned chat window that stays visible over other apps
- **Multi-provider** - supports Anthropic, OpenAI, and OpenRouter (300+ models)
- **HIPAA mode** - force all processing local (transcription + TTS) except the LLM call
- **Lives in your tray** - runs quietly as a system tray app

## Download

### Installer (recommended)

Build the installer (below), then run **Evolute-Setup.exe**. It installs per user, so there is no admin prompt and no dependencies to install first.

### Build from source

You'll need [Node.js](https://nodejs.org/) (v18+) installed.

```bash
npm install
npx tsc
npm run dev
```

> **Note:** `npm run dev` does not compile TypeScript for you. You must run `npx tsc` before the first launch and after every source change, or run `npx tsc --watch` in a second terminal.

### Build a distributable installer

```bash
npx tsc
npm run make
```

The installer is written to `<build root>/make/squirrel.windows/x64/Evolute-Setup.exe`. The build root defaults to `S:/evolute-build/out` and is overridable with the `EVOLUTE_OUT_DIR` environment variable.

## Setup

1. Launch Evolute (or run `npm run dev`)
2. Open **Settings** from the system tray icon
3. Enter your API key(s):
   - **Required:** [Anthropic API key](https://console.anthropic.com/) (or use OpenRouter/OpenAI)
   - **Optional:** [AssemblyAI](https://www.assemblyai.com/) for voice transcription
   - **Optional:** [ElevenLabs](https://elevenlabs.io/) for premium TTS

## Features

### Voice Input

Hold the push-to-talk hotkey (default: `Ctrl+Shift+Space`) to record, release to send. Transcription providers:
- **AssemblyAI** - cloud, high accuracy
- **OpenAI Whisper** - cloud, fast
- **Whisper Local** - offline, private (uses whisper.cpp)

### Text-to-Speech

- **Windows SAPI** - free, offline, works out of the box
- **OpenAI TTS** - cloud, natural sounding
- **ElevenLabs** - cloud, premium quality

### Cursor Buddy

A small glowing purple V that sits just off your mouse pointer, marking the app as live without getting in the way. Toggle on/off in **Settings > Window > "Cursor buddy"**. Enabled by default.

### AI Pointing

When Claude references UI elements on your screen, it uses `[POINT]` tags to animate a cursor overlay that highlights exactly what it's talking about. Works across multi-monitor setups.

### HIPAA Mode

Toggle in Settings to force all processing to stay local:
- Transcription: local Whisper (no audio leaves device)
- TTS: Windows SAPI (no text leaves device)
- Only the LLM API call goes external (requires BAA with Anthropic)

## Architecture

```
src/
├── main/           # Electron main process
│   ├── index.ts        # App entry, window creation, cursor buddy
│   ├── companion.ts    # Central orchestrator (voice → screen → claude → tts → overlay)
│   ├── screenshot.ts   # Screen capture via desktopCapturer
│   ├── hotkey.ts       # Global push-to-talk hotkey
│   ├── audio.ts        # Audio capture coordination
│   ├── tray.ts         # System tray setup
│   └── settings.ts     # Persistent JSON settings store
├── services/       # External service integrations
│   ├── claude.ts       # Anthropic Claude API (vision + chat)
│   ├── openai-chat.ts  # OpenAI GPT API
│   ├── openrouter-chat.ts  # OpenRouter API (300+ models)
│   ├── transcription/  # Pluggable: AssemblyAI, OpenAI, local Whisper
│   └── tts/            # Pluggable: ElevenLabs, OpenAI, Windows SAPI
├── preload/        # Context bridge for renderer
└── renderer/       # UI
    ├── chat/           # Chat window with markdown rendering
    ├── overlay/        # Transparent click-through window with cursor buddy + point animations
    └── settings/       # Settings panel
```

## Contributing

PRs welcome. See `docs/plans/` for what's in progress.

## License

MIT
