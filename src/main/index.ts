import { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen, shell } from "electron";
import { createTray } from "./tray";
import { HotkeyManager } from "./hotkey";
import { AudioCapture } from "./audio";
import { SettingsStore } from "./settings";
import { CompanionManager } from "./companion";
import { ProjectStore } from "./project-store";
import path from "path";

let chatWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let overlayWindows: BrowserWindow[] = [];

const settings = new SettingsStore();
// Constructed once the app is ready: its files live under `userData`, and
// `app.getPath("userData")` is only reliable after that point.
let projects: ProjectStore;
let companion: CompanionManager;
let cursorBuddyInterval: ReturnType<typeof setInterval> | null = null;

function startCursorBuddy(): void {
  if (cursorBuddyInterval) return;
  cursorBuddyInterval = setInterval(() => {
    if (overlayWindows.length === 0) return;
    const point = screen.getCursorScreenPoint();
    // Route the buddy to the overlay for the display that contains the
    // cursor; hide it on every other overlay. Coordinates are translated
    // into that display's local CSS space (matches how POINT tags work).
    const target = screen.getDisplayNearestPoint(point);
    const displays = screen.getAllDisplays();
    const targetIndex = displays.findIndex((d) => d.id === target.id);
    for (let i = 0; i < overlayWindows.length; i++) {
      const win = overlayWindows[i];
      if (!win || win.isDestroyed()) continue;
      if (i === targetIndex) {
        const localX = point.x - target.bounds.x;
        const localY = point.y - target.bounds.y;
        win.webContents.send("overlay:cursor-buddy", localX, localY);
      } else {
        win.webContents.send("overlay:cursor-buddy-visible", false);
      }
    }
  }, 16);
}

function stopCursorBuddy(): void {
  if (cursorBuddyInterval) {
    clearInterval(cursorBuddyInterval);
    cursorBuddyInterval = null;
  }
  for (const win of overlayWindows) {
    if (win && !win.isDestroyed()) {
      win.webContents.send("overlay:cursor-buddy-visible", false);
    }
  }
}

/**
 * Create one transparent click-through overlay window per display. The
 * array index matches `screen.getAllDisplays()` order, which is also the
 * order used by `ScreenCapture.captureAllScreens`, so a POINT tag's
 * `screen` field directly indexes into this array.
 */
function createOverlayWindows(): BrowserWindow[] {
  return screen.getAllDisplays().map((display, i) => createOverlayWindow(display, i));
}

function createOverlayWindow(display: Electron.Display, displayIndex: number): BrowserWindow {
  const { x, y, width, height } = display.bounds;

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setIgnoreMouseEvents(true, { forward: true });
  win.setAlwaysOnTop(true, "screen-saver");
  win.loadFile(path.join(__dirname, "..", "..", "src", "renderer", "overlay", "index.html"));

  // Forward overlay renderer console messages to main process so we can see
  // them in PowerShell during dev. Prefixed with the display index for
  // multi-monitor clarity.
  win.webContents.on("console-message", (_event, level, message, line) => {
    console.log(`[overlay${displayIndex}:${level}] ${message} (line ${line})`);
  });

  // Open DevTools only for the primary display in dev mode - opening one
  // detached DevTools window per monitor is too noisy.
  if (!app.isPackaged && displayIndex === 0) {
    win.webContents.once("did-finish-load", () => {
      win.webContents.openDevTools({ mode: "detach" });
    });
  }

  // Show after load is ready (transparent + show:false avoids a black flash on Windows)
  win.once("ready-to-show", () => {
    win.showInactive();
    win.setAlwaysOnTop(true, "screen-saver");
    console.log(`[Evolute] Overlay ${displayIndex} shown:`, win.getBounds(), "isVisible:", win.isVisible());
  });

  // Fallback: if ready-to-show never fires (transparent windows can be tricky),
  // force-show after the load completes.
  win.webContents.once("did-finish-load", () => {
    if (!win.isVisible()) {
      win.showInactive();
      win.setAlwaysOnTop(true, "screen-saver");
      console.log(`[Evolute] Overlay ${displayIndex} forced-shown after did-finish-load:`, win.getBounds());
    }
  });

  return win;
}

function createChatWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 550,
    resizable: true,
    show: false,
    frame: false,
    transparent: false,
    alwaysOnTop: settings.get("alwaysOnTop"),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "..", "src", "renderer", "chat", "index.html"));
  win.once("ready-to-show", () => {
    win.show();
    // setAlwaysOnTop after show - more reliable on Windows than constructor option
    if (settings.get("alwaysOnTop")) {
      win.setAlwaysOnTop(true, "screen-saver");
      // Re-apply after a short delay - Windows can reset it
      setTimeout(() => {
        if (!win.isDestroyed()) {
          win.setAlwaysOnTop(true, "screen-saver");
          // alwaysOnTop applied
        }
      }, 500);
    }
  });
  return win;
}

function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 500,
    height: 600,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "..", "src", "renderer", "settings", "index.html"));
  win.once("ready-to-show", () => win.show());
  return win;
}

/** Push the current document set to every window so open panels stay in sync. */
function broadcastDocs(summary: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("docs:changed", summary);
    }
  }
}

function setupIPC(): void {
  // Chat query - captures screen + sends to Claude
  ipcMain.handle("chat:query", async (_event, text: string) => {
    try {
      const response = await companion.processQuery(text);
      return response;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(msg);
    }
  });

  // ── Project context ──
  //
  // The renderer never receives document text, only the metadata it needs to
  // draw the list. Sending hundreds of kilobytes over IPC on every panel open
  // would buy nothing, and the text has no business in a window that also
  // renders remote markdown.

  ipcMain.handle("docs:list", () => projects.summary());

  ipcMain.handle("docs:add", async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "Add project documents",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Text and docs", extensions: ["md", "markdown", "txt", "rst", "adoc"] },
        { name: "Data", extensions: ["json", "yaml", "yml", "toml", "csv", "xml"] },
        { name: "Source", extensions: ["ts", "tsx", "js", "jsx", "py", "go", "rs", "java", "cs", "c", "h", "cpp", "sh", "ps1", "sql", "html", "css"] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    const added = projects.addPaths(result.filePaths);
    broadcastDocs(added);
    return added;
  });

  ipcMain.handle("docs:addFolder", async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    // Windows cannot show a picker that accepts files and folders at once, so
    // folders get their own entry point rather than a combined one.
    const options: Electron.OpenDialogOptions = {
      title: "Add a project folder",
      properties: ["openDirectory"],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    const added = projects.addPaths(result.filePaths);
    broadcastDocs(added);
    return added;
  });

  // Drag and drop. Electron 33 no longer exposes `File.path`, so the renderer
  // resolves each dropped file through `webUtils.getPathForFile` in the
  // preload and sends the resulting paths here.
  ipcMain.handle("docs:addPaths", (_event, paths: unknown) => {
    if (!Array.isArray(paths)) return projects.summary();
    const clean = paths.filter((p): p is string => typeof p === "string" && p.length > 0);
    if (clean.length === 0) return projects.summary();
    const added = projects.addPaths(clean);
    broadcastDocs(added);
    return added;
  });

  ipcMain.handle("docs:remove", (_event, id: string) => {
    const summary = projects.removeDocument(id);
    broadcastDocs(summary);
    return summary;
  });

  ipcMain.handle("docs:clear", () => {
    const summary = projects.clearDocuments();
    broadcastDocs(summary);
    return summary;
  });

  // ── Conversation ──

  ipcMain.handle("history:get", () => companion.getHistory());

  ipcMain.handle("sessions:list", () => ({
    sessions: companion.listSessions(),
    activeId: companion.activeSessionId(),
  }));

  ipcMain.handle("sessions:new", () => {
    companion.newSession();
    return {
      sessions: companion.listSessions(),
      activeId: companion.activeSessionId(),
      entries: [],
    };
  });

  ipcMain.handle("sessions:switch", (_event, id: string) => ({
    entries: companion.switchSession(id),
    sessions: companion.listSessions(),
    activeId: companion.activeSessionId(),
  }));

  ipcMain.handle("sessions:delete", (_event, id: string) => {
    const result = companion.deleteSession(id);
    return { ...result, entries: companion.getHistory() };
  });

  // Settings
  ipcMain.handle("settings:getAll", () => settings.getAll());
  ipcMain.handle("settings:set", (_event, key: string, value: unknown) => {
    settings.set(key as keyof ReturnType<typeof settings.getAll>, value as never);

    // Apply alwaysOnTop immediately
    if (key === "alwaysOnTop" && chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.setAlwaysOnTop(!!value, "screen-saver");
    }

    // Toggle cursor buddy
    if (key === "cursorBuddyEnabled") {
      if (value) startCursorBuddy();
      else stopCursorBuddy();
    }
  });

  // Open URL in default browser
  ipcMain.handle("shell:openExternal", (_event, url: string) => {
    if (url.startsWith("https://")) {
      shell.openExternal(url);
    }
  });

  // Window controls
  ipcMain.handle("window:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle("window:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

app.whenReady().then(() => {
  // Hide from taskbar - tray only
  app.dock?.hide?.();

  overlayWindows = createOverlayWindows();
  projects = new ProjectStore();
  companion = new CompanionManager(settings, overlayWindows, projects);

  const audioCapture = new AudioCapture(settings);
  audioCapture.setCompanion(companion);

  setupIPC();

  const tray = createTray({
    onChat: () => {
      if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.focus();
      } else {
        chatWindow = createChatWindow();
        chatWindow.on("closed", () => {
          chatWindow = null;
        });
      }
    },
    onSettings: () => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.focus();
      } else {
        settingsWindow = createSettingsWindow();
        settingsWindow.on("closed", () => {
          settingsWindow = null;
        });
      }
    },
    onQuit: () => app.quit(),
  });

  const hotkeyManager = new HotkeyManager(settings);
  hotkeyManager.register();

  // Open chat on launch so there's something visible
  chatWindow = createChatWindow();
  chatWindow.on("closed", () => {
    chatWindow = null;
  });

  // Start cursor buddy if enabled
  if (settings.get("cursorBuddyEnabled")) {
    startCursorBuddy();
  }

  console.log("Evolute Windows started - running in system tray");
});

/**
 * Tear down everything that draws on screen.
 *
 * The overlays are transparent, always-on-top, click-through windows built
 * with `closable: false`, so `close()` is a no-op on them and quitting used to
 * leave the blue cursor painted over the desktop with no window to dismiss it.
 * `destroy()` is the only thing that takes them down.
 */
function destroyOverlays(): void {
  stopCursorBuddy();
  for (const win of overlayWindows) {
    if (win && !win.isDestroyed()) {
      win.destroy();
    }
  }
  overlayWindows = [];
}

app.on("before-quit", () => {
  destroyOverlays();
  // Local TTS speaks through a PowerShell child process, which outlives its
  // parent quite happily and would keep talking to an empty desktop.
  companion?.stopSpeaking();
});

app.on("will-quit", () => {
  // Belt and braces: `before-quit` can be skipped when the process is asked to
  // exit some other way, and a stranded overlay survives the app that owns it.
  destroyOverlays();
  companion?.stopSpeaking();
  globalShortcut.unregisterAll();
});

// Prevent app from closing when all windows are closed (tray app)
app.on("window-all-closed", () => {
  // Do nothing - keep app running in tray
});
