import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("evolute", {
  // Hotkey events
  onRecordingChanged: (callback: (isRecording: boolean) => void) => {
    ipcRenderer.on("hotkey:recording-changed", (_event, isRecording) => {
      callback(isRecording);
    });
  },

  // Overlay pointing
  onPoint: (
    callback: (
      tags: Array<{ x: number; y: number; label: string; screen: number }>
    ) => void
  ) => {
    ipcRenderer.on("overlay:point", (_event, tags) => {
      callback(tags);
    });
  },

  // TTS audio playback
  onTTSPlay: (callback: (audioData: ArrayBuffer) => void) => {
    ipcRenderer.on("tts:play", (_event, data) => {
      callback(data);
    });
  },

  // Voice transcript from push-to-talk
  onVoiceTranscript: (callback: (transcript: string) => void) => {
    ipcRenderer.on("voice:transcript", (_event, transcript) => {
      callback(transcript);
    });
  },

  // Cursor buddy
  onCursorBuddy: (callback: (x: number, y: number) => void) => {
    ipcRenderer.on("overlay:cursor-buddy", (_event, x, y) => {
      callback(x, y);
    });
  },

  onCursorBuddyVisible: (callback: (visible: boolean) => void) => {
    ipcRenderer.on("overlay:cursor-buddy-visible", (_event, visible) => {
      callback(visible);
    });
  },

  // Streamed reply: "start" opens a bubble, "delta" appends to it, "end"
  // closes it. Lets the answer appear while it is still being generated.
  onStream: (
    callback: (event: { type: "start" | "delta" | "end"; text?: string }) => void
  ) => {
    ipcRenderer.on("chat:stream", (_event, data) => {
      callback(data);
    });
  },

  // Keeps the main process in step when the renderer ends a recording itself.
  setRecordingState: (recording: boolean): Promise<void> =>
    ipcRenderer.invoke("hotkey:setRecording", recording),

  // Processing stage updates from companion pipeline
  onStage: (callback: (data: { stage: string; label: string }) => void) => {
    ipcRenderer.on("companion:stage", (_event, data) => {
      callback(data);
    });
  },

  // Project context (documents attached as standing background context)
  listDocs: () => ipcRenderer.invoke("docs:list"),
  addDocs: () => ipcRenderer.invoke("docs:add"),
  addDocsFolder: () => ipcRenderer.invoke("docs:addFolder"),
  addDocPaths: (paths: string[]) => ipcRenderer.invoke("docs:addPaths", paths),
  removeDoc: (id: string) => ipcRenderer.invoke("docs:remove", id),
  clearDocs: () => ipcRenderer.invoke("docs:clear"),
  onDocsChanged: (callback: (summary: unknown) => void) => {
    ipcRenderer.on("docs:changed", (_event, summary) => {
      callback(summary);
    });
  },

  /**
   * Absolute path of a dropped File.
   *
   * Electron 33 removed the `File.path` property that used to carry this, so
   * a drag-and-drop handler in the renderer has no way to name the file it was
   * given without going through `webUtils` here in the preload.
   */
  getFilePath: (file: File): string => webUtils.getPathForFile(file),

  // Conversation
  getHistory: (): Promise<Array<{ role: string; content: string }>> =>
    ipcRenderer.invoke("history:get"),

  // Chat history: every conversation is a session, listed newest first.
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  newSession: () => ipcRenderer.invoke("sessions:new"),
  switchSession: (id: string) => ipcRenderer.invoke("sessions:switch", id),
  deleteSession: (id: string) => ipcRenderer.invoke("sessions:delete", id),

  // Settings
  getSettings: () => ipcRenderer.invoke("settings:getAll"),
  setSetting: (key: string, value: unknown) =>
    ipcRenderer.invoke("settings:set", key, value),

  // Chat - send a text query (captures screen + sends to Claude)
  sendQuery: (text: string): Promise<string> =>
    ipcRenderer.invoke("chat:query", text),

  // Audio - send complete recording for transcription + AI query
  sendAudioRecording: (audioData: ArrayBuffer): Promise<{ transcript?: string; response?: string; error?: string }> =>
    ipcRenderer.invoke("audio:recording-complete", audioData),

  // Open URL in default browser
  openExternal: (url: string) => {
    ipcRenderer.invoke("shell:openExternal", url);
  },

  // Window controls
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
});
