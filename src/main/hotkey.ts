import { globalShortcut, ipcMain, BrowserWindow } from "electron";
import { SettingsStore } from "./settings";

export class HotkeyManager {
  private settings: SettingsStore;
  private isRecording = false;

  constructor(settings: SettingsStore) {
    this.settings = settings;
  }

  register(): void {
    const hotkey = this.settings.get("pushToTalkHotkey", "Ctrl+Alt");

    // Register push-to-talk activation
    globalShortcut.register(`${hotkey}+Space`, () => {
      this.toggleRecording();
    });

    // IPC listeners for renderer
    ipcMain.handle("hotkey:isRecording", () => this.isRecording);

    // The renderer can end a recording without being told to: it stops on its
    // own when it hears silence, and the mic button stops one on click.
    // Without this the manager's flag stays true, so the next hotkey press
    // only flips it back to false and the user has to press twice to talk.
    ipcMain.handle("hotkey:setRecording", (_event, recording: boolean) => {
      this.isRecording = !!recording;
    });
  }

  private toggleRecording(): void {
    this.isRecording = !this.isRecording;

    // Notify all renderer windows
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send(
        "hotkey:recording-changed",
        this.isRecording
      );
    });

    if (this.isRecording) {
      console.log("Push-to-talk: recording started");
    } else {
      console.log("Push-to-talk: recording stopped");
    }
  }

  unregister(): void {
    globalShortcut.unregisterAll();
  }
}
