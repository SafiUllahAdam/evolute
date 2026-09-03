import { app } from "electron";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * Project context: the documents the user attaches once, plus the conversation
 * that survives a restart.
 *
 * Two files rather than one, both under `userData`:
 *
 *   docs.json          the attached files, including their full text
 *   sessions.json      the chat list, and which chat is open
 *   sessions/<id>.json one chat's conversation
 *
 * History is rewritten after every single turn, and docs can run to hundreds of
 * kilobytes. Keeping them apart means a turn writes a few KB instead of
 * re-serialising the whole document set each time.
 */

/** One attached file. `text` is the whole file - this is what gets sent. */
export interface ProjectDoc {
  id: string;
  name: string;
  path: string;
  text: string;
  tokens: number;
  addedAt: number;
}

/** Metadata only. The chat window renders from this and never sees the text. */
export interface ProjectDocInfo {
  id: string;
  name: string;
  path: string;
  tokens: number;
}

export interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
}

/** One chat in the history list. */
export interface SessionMeta {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

/** Placeholder until the user says something worth naming the chat after. */
const NEW_CHAT_TITLE = "New chat";

/** Oldest chats past this are deleted, so the list stays usable. */
const MAX_SESSIONS = 30;

/** First line of the opening question, trimmed to fit the history list. */
function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return NEW_CHAT_TITLE;
  return line.length > 48 ? line.slice(0, 47).trimEnd() + "…" : line;
}

export interface DocsSummary {
  docs: ProjectDocInfo[];
  tokens: number;
  budget: number;
}

export interface AddResult extends DocsSummary {
  added: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Ceiling on the combined document text, in estimated tokens.
 *
 * Not an arbitrary round number: a query already spends roughly 1,800 tokens
 * per screen on images plus a ~1,500 token system prompt and up to 20 turns of
 * history, and every provider here caps out well below its advertised context
 * once those are added. 60k leaves comfortable room on a 200k model while
 * still fitting a normal project's docs. Going over is refused at add time,
 * with a message, rather than failing later as an opaque API 400.
 */
const TOKEN_BUDGET = 60_000;

/** Roughly four characters per token for English prose and source code. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Per-file ceiling, before the budget is even consulted. */
const MAX_FILE_BYTES = 512 * 1024;

/** Cap on how many files one folder pick can contribute. */
const MAX_FOLDER_FILES = 60;

/**
 * Text formats only. Anything else needs a parser dependency, and silently
 * feeding a model the bytes of a PDF or a .docx produces confident nonsense.
 */
const TEXT_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".text", ".rst", ".adoc",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".csv", ".tsv", ".log",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".cs", ".swift",
  ".c", ".h", ".cpp", ".hpp", ".cc",
  ".sh", ".bash", ".ps1", ".bat",
  ".sql", ".graphql", ".proto",
  ".html", ".htm", ".css", ".scss", ".less", ".xml", ".svg",
]);

/**
 * Never ingested, even though the extension rules would allow some of them.
 * `.env` and friends are the obvious way to mail an API key to a model
 * provider by accident.
 */
const BLOCKED_NAMES = new Set([
  ".env", ".env.local", ".env.development", ".env.production",
  "id_rsa", "id_ed25519", ".npmrc", ".netrc",
  "settings.json",
]);

/** Directories that would flood the budget with machine-generated files. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "out", "build", ".next", ".cache",
  "coverage", "__pycache__", ".venv", "venv", "vendor", ".idea", ".vscode",
]);

function isBlocked(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (BLOCKED_NAMES.has(base)) return true;
  // `.env.whatever` in all its variants.
  return base.startsWith(".env");
}

export class ProjectStore {
  private docs: ProjectDoc[] = [];
  private history: ConversationEntry[] = [];
  private docsPath: string;
  private sessionsPath: string;
  private sessionsDir: string;
  private legacyHistoryPath: string;
  private sessions: SessionMeta[] = [];
  private activeId = "";

  constructor() {
    const userDataPath = app.isReady()
      ? app.getPath("userData")
      : path.join(process.env.APPDATA || process.env.HOME || ".", "evolute-windows");

    this.docsPath = path.join(userDataPath, "docs.json");
    this.sessionsPath = path.join(userDataPath, "sessions.json");
    this.sessionsDir = path.join(userDataPath, "sessions");
    this.legacyHistoryPath = path.join(userDataPath, "history.json");

    this.docs = this.readJson<ProjectDoc[]>(this.docsPath, "docs") ?? [];
    this.loadSessions();
  }

  // ── Documents ────────────────────────────────────────────────────────────

  /**
   * Ingest a list of files and/or folders. Returns what landed and, for
   * everything rejected, why - the caller shows both, because a silent skip
   * looks identical to a bug from the user's side.
   */
  addPaths(inputPaths: string[]): AddResult {
    const added: string[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];

    const files: string[] = [];
    for (const input of inputPaths) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(input);
      } catch {
        skipped.push({ name: path.basename(input), reason: "cannot be read" });
        continue;
      }
      if (stat.isDirectory()) {
        const found = this.walkDirectory(input);
        if (found.length === 0) {
          skipped.push({ name: path.basename(input), reason: "no text files found" });
        }
        files.push(...found);
      } else {
        files.push(input);
      }
    }

    for (const file of files) {
      const name = path.basename(file);

      if (this.docs.some((d) => d.path === file)) {
        skipped.push({ name, reason: "already attached" });
        continue;
      }
      if (isBlocked(file)) {
        skipped.push({ name, reason: "blocked (may contain secrets)" });
        continue;
      }
      if (!TEXT_EXTENSIONS.has(path.extname(file).toLowerCase())) {
        skipped.push({ name, reason: "not a supported text format" });
        continue;
      }

      let text: string;
      try {
        const stat = fs.statSync(file);
        if (stat.size > MAX_FILE_BYTES) {
          skipped.push({ name, reason: `larger than ${MAX_FILE_BYTES / 1024} KB` });
          continue;
        }
        text = fs.readFileSync(file, "utf-8");
      } catch {
        skipped.push({ name, reason: "cannot be read" });
        continue;
      }

      // A NUL byte means it decoded as text but is not text. Extension checks
      // do not catch a binary blob that happens to be called notes.txt.
      if (text.includes("\u0000")) {
        skipped.push({ name, reason: "looks binary" });
        continue;
      }
      if (!text.trim()) {
        skipped.push({ name, reason: "empty" });
        continue;
      }

      const tokens = estimateTokens(text);
      if (this.totalTokens() + tokens > TOKEN_BUDGET) {
        skipped.push({ name, reason: "would exceed the context budget" });
        continue;
      }

      this.docs.push({
        id: randomUUID(),
        name,
        path: file,
        text,
        tokens,
        addedAt: Date.now(),
      });
      added.push(name);
    }

    if (added.length > 0) this.saveDocs();
    return { ...this.summary(), added, skipped };
  }

  removeDocument(id: string): DocsSummary {
    const before = this.docs.length;
    this.docs = this.docs.filter((d) => d.id !== id);
    if (this.docs.length !== before) this.saveDocs();
    return this.summary();
  }

  clearDocuments(): DocsSummary {
    if (this.docs.length > 0) {
      this.docs = [];
      this.saveDocs();
    }
    return this.summary();
  }

  summary(): DocsSummary {
    return {
      docs: this.docs.map(({ id, name, path: p, tokens }) => ({ id, name, path: p, tokens })),
      tokens: this.totalTokens(),
      budget: TOKEN_BUDGET,
    };
  }

  /**
   * The concatenated document text, or an empty string when nothing is
   * attached. Providers put this in the system prompt, once - never in the
   * message history, where every turn would pay for it again.
   */
  getDocumentContext(): string {
    if (this.docs.length === 0) return "";
    return this.docs
      .map((doc) => `--- FILE: ${doc.name} ---\n${doc.text}\n--- END FILE: ${doc.name} ---`)
      .join("\n\n");
  }

  private totalTokens(): number {
    return this.docs.reduce((sum, doc) => sum + doc.tokens, 0);
  }

  /** Breadth-first so a shallow README is picked up before deep source files. */
  private walkDirectory(root: string): string[] {
    const found: string[] = [];
    const queue: string[] = [root];

    while (queue.length > 0 && found.length < MAX_FOLDER_FILES) {
      const dir = queue.shift() as string;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
          queue.push(full);
        } else if (entry.isFile()) {
          if (found.length >= MAX_FOLDER_FILES) break;
          if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
            found.push(full);
          }
        }
      }
    }

    return found;
  }

  // ── Conversations ────────────────────────────────────────────────────────
  //
  // Each chat is its own session, stored as `sessions/<id>.json`, with a small
  // index in `sessions.json` naming them and recording which one is open.
  // Split that way because a turn rewrites only the open conversation: keeping
  // every chat in one file would mean serialising all of them after every
  // single question.

  /** Sessions shown in the history list, newest first. */
  listSessions(): SessionMeta[] {
    return this.sessions
      .map((s) => ({ ...s }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  activeSessionId(): string {
    return this.activeId;
  }

  /** Entries of the open conversation. */
  getHistory(): ConversationEntry[] {
    return this.history.map((entry) => ({ ...entry }));
  }

  /**
   * Persists the open conversation and refreshes its index entry.
   *
   * The title is taken from the first thing the user said, the way every chat
   * app does it, so the history list reads as a list of questions rather than
   * a column of timestamps.
   */
  saveHistory(entries: ConversationEntry[]): void {
    this.history = entries.map((entry) => ({ ...entry }));
    this.writeJson(this.sessionFile(this.activeId), {
      version: 1,
      entries: this.history,
    });

    const meta = this.sessions.find((s) => s.id === this.activeId);
    if (meta) {
      meta.updatedAt = Date.now();
      meta.messageCount = this.history.length;
      if (meta.title === NEW_CHAT_TITLE) {
        const firstUser = this.history.find((e) => e.role === "user");
        if (firstUser) meta.title = titleFrom(firstUser.content);
      }
    }
    this.saveSessionIndex();
  }

  /** Opens a brand new chat and makes it the active one. */
  newSession(): SessionMeta {
    const meta: SessionMeta = {
      id: randomUUID(),
      title: NEW_CHAT_TITLE,
      updatedAt: Date.now(),
      messageCount: 0,
    };
    this.sessions.push(meta);
    this.activeId = meta.id;
    this.history = [];

    // An untouched empty chat is noise in the list, so opening a new one
    // clears out any earlier empties rather than stacking them up.
    this.sessions = this.sessions.filter(
      (s) => s.id === this.activeId || s.messageCount > 0
    );
    this.prune();
    this.writeJson(this.sessionFile(meta.id), { version: 1, entries: [] });
    this.saveSessionIndex();
    return { ...meta };
  }

  /** Switches to an existing chat and returns its conversation. */
  switchSession(id: string): ConversationEntry[] {
    if (!this.sessions.some((s) => s.id === id)) return this.getHistory();
    this.activeId = id;
    this.history =
      this.readJson<ConversationEntry[]>(this.sessionFile(id), "entries") ?? [];
    this.saveSessionIndex();
    return this.getHistory();
  }

  /**
   * Deletes a chat. Removing the open one falls through to the most recent
   * survivor, creating a fresh chat if that was the last one.
   */
  deleteSession(id: string): { sessions: SessionMeta[]; activeId: string; switched: boolean } {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    try {
      fs.rmSync(this.sessionFile(id), { force: true });
    } catch {
      // Already gone.
    }

    let switched = false;
    if (this.activeId === id) {
      switched = true;
      const next = this.listSessions()[0];
      if (next) {
        this.switchSession(next.id);
      } else {
        this.newSession();
      }
    } else {
      this.saveSessionIndex();
    }

    return { sessions: this.listSessions(), activeId: this.activeId, switched };
  }

  /** Empties the open chat without creating a new one. */
  clearHistory(): void {
    this.history = [];
    this.writeJson(this.sessionFile(this.activeId), { version: 1, entries: [] });
    const meta = this.sessions.find((s) => s.id === this.activeId);
    if (meta) {
      meta.messageCount = 0;
      meta.title = NEW_CHAT_TITLE;
      meta.updatedAt = Date.now();
    }
    this.saveSessionIndex();
  }

  private sessionFile(id: string): string {
    return path.join(this.sessionsDir, `${id}.json`);
  }

  private saveSessionIndex(): void {
    this.writeJson(this.sessionsPath, {
      version: 1,
      activeId: this.activeId,
      sessions: this.sessions,
    });
  }

  /** Drops the oldest chats once the list gets long, and their files with them. */
  private prune(): void {
    if (this.sessions.length <= MAX_SESSIONS) return;
    const keep = this.listSessions().slice(0, MAX_SESSIONS);
    const keepIds = new Set(keep.map((s) => s.id));
    for (const stale of this.sessions) {
      if (!keepIds.has(stale.id)) {
        try {
          fs.rmSync(this.sessionFile(stale.id), { force: true });
        } catch {
          // Already gone.
        }
      }
    }
    this.sessions = this.sessions.filter((s) => keepIds.has(s.id));
  }

  /**
   * Restores the session list, converting the single `history.json` written by
   * earlier versions into the first chat so nobody loses a conversation to the
   * upgrade.
   */
  private loadSessions(): void {
    try {
      if (!fs.existsSync(this.sessionsDir)) {
        fs.mkdirSync(this.sessionsDir, { recursive: true });
      }
    } catch {
      // writeJson reports the real problem if the directory is unusable.
    }

    let index: { activeId?: string; sessions?: SessionMeta[] } | null = null;
    try {
      if (fs.existsSync(this.sessionsPath)) {
        index = JSON.parse(fs.readFileSync(this.sessionsPath, "utf-8"));
      }
    } catch {
      index = null;
    }

    this.sessions = Array.isArray(index?.sessions) ? (index as { sessions: SessionMeta[] }).sessions : [];

    if (this.sessions.length === 0) {
      const legacy =
        this.readJson<ConversationEntry[]>(this.legacyHistoryPath, "entries") ?? [];
      const meta: SessionMeta = {
        id: randomUUID(),
        title: legacy.length > 0 ? titleFrom(legacy[0].content) : NEW_CHAT_TITLE,
        updatedAt: Date.now(),
        messageCount: legacy.length,
      };
      this.sessions = [meta];
      this.activeId = meta.id;
      this.history = legacy;
      this.writeJson(this.sessionFile(meta.id), { version: 1, entries: legacy });
      this.saveSessionIndex();
      return;
    }

    const wanted = index?.activeId;
    this.activeId =
      wanted && this.sessions.some((s) => s.id === wanted)
        ? wanted
        : this.listSessions()[0].id;
    this.history =
      this.readJson<ConversationEntry[]>(this.sessionFile(this.activeId), "entries") ?? [];
  }

  // ── Disk ─────────────────────────────────────────────────────────────────

  private saveDocs(): void {
    this.writeJson(this.docsPath, { version: 1, docs: this.docs });
  }

  private readJson<T>(file: string, key: string): T | null {
    try {
      if (!fs.existsSync(file)) return null;
      const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
      const value = parsed[key];
      return Array.isArray(value) ? (value as T) : null;
    } catch {
      // A corrupt file should cost the user their history, not the app's start.
      return null;
    }
  }

  /**
   * Write to a sibling temp file and rename over the target. A crash midway
   * through a direct write leaves truncated JSON, which reads back as a total
   * loss of the conversation rather than the loss of one turn.
   */
  private writeJson(file: string, data: unknown): void {
    try {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch {
      // Silent, matching SettingsStore: an unwritable profile directory must
      // not take down a query that has already been answered.
    }
  }
}
