import * as path from "path";
import iconv from "iconv-lite";
import * as vscode from "vscode";
import * as fs from "fs";
import * as fsPromises from "fs/promises";
import {
  CHUNK_SIZE, HEX_DUMP_SIZE, SEARCH_WINDOW, SCAN_STEP,
  filterText, chunkStats, escapeHtml, formatSize,
  hexDump, probeEncoding, analyseChunk,
} from "./utils";
import { getWebviewHtml } from "./webview";

const ABORT_TIMEOUT = 8000;
const READY_TIMEOUT = 5000;

type ViewMode = "text" | "hex" | "raw";
type SkipMode = "off" | "readable" | "unreadable";

interface BackendState {
  fd: number | null;
  fileSize: number;
  currentOffset: number;
  viewMode: ViewMode;
  encoding: string;
  wrapEnabled: boolean;
  skipMode: SkipMode;
  scanController: AbortController | null;
  loadSeq: number;
  avgLineLen: number;
  totalLinesSeen: number;
  startLine: number;
  sequential: boolean;
}

export class ExaPagerPanel {
  public static currentPanel: ExaPagerPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly filePath: string;
  private readonly disposables: vscode.Disposable[] = [];
  private state: BackendState;

  private constructor(panel: vscode.WebviewPanel, filePath: string) {
    this.panel = panel;
    this.filePath = filePath;
    this.state = {
      fd: null, fileSize: 0, currentOffset: 0,
      viewMode: "text", encoding: "utf-8", wrapEnabled: true,
      skipMode: "off", scanController: null, loadSeq: 0,
      avgLineLen: 0, totalLinesSeen: 0, startLine: 1, sequential: true,
    };

    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.onDidChangeViewState(e => { if (e.webviewPanel.viewColumn === undefined) this.dispose(); }, null, this.disposables);
    vscode.window.onDidChangeActiveColorTheme(() => this.sendTheme(), null, this.disposables);

    // Set context key for keybindings
    vscode.commands.executeCommand("setContext", "exapager.active", true);

    panel.webview.html = getWebviewHtml();
    panel.webview.onDidReceiveMessage(async msg => await this.handleMessage(msg), undefined, this.disposables);

    this.init();
  }

  public static render(extensionUri: vscode.Uri, filePath: string): void {
    if (ExaPagerPanel.currentPanel) {
      if (ExaPagerPanel.currentPanel.filePath !== filePath) {
        ExaPagerPanel.currentPanel.dispose();
        ExaPagerPanel.currentPanel = undefined;
        ExaPagerPanel.render(extensionUri, filePath);
        return;
      }
      ExaPagerPanel.currentPanel.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel("exapager", `ExaPager: ${path.basename(filePath)}`, vscode.ViewColumn.One, {
      enableScripts: true, localResourceRoots: [],
    });
    ExaPagerPanel.currentPanel = new ExaPagerPanel(panel, filePath);
  }

  // ---- Init ----

  private async init() {
    try {
      const stat = await fsPromises.stat(this.filePath);
      this.state.fileSize = stat.size;
      this.state.fd = await new Promise<number>((res, rej) =>
        fs.open(this.filePath, "r", (err, fd) => err ? rej(err) : res(fd))
      );
      this.sendTheme();
      this.post("fileInfo", { name: path.basename(this.filePath), size: this.state.fileSize });
      await this.waitForReady();
      await this.loadChunk(0);
    } catch (err: any) {
      this.showError(`Failed to open file: ${err?.message ?? String(err)}`);
    }
  }

  private waitForReady(): Promise<void> {
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { rej(new Error("Webview ready timeout")); }, READY_TIMEOUT);
      const sub = this.panel.webview.onDidReceiveMessage(msg => {
        if (msg.cmd === "ready") { clearTimeout(timer); sub.dispose(); res(); }
      });
    });
  }

  // ---- Message routing ----

  private async handleMessage(msg: { cmd: string; [key: string]: any }): Promise<void> {
    switch (msg.cmd) {
      case "ready": break;
      case "loadChunk": await this.loadChunk(msg.offset); break;
      case "hexDump": await this.hexDump(msg.offset); break;
      case "search": await this.search(msg.query, msg.wholeFile); break;
      case "skip": await this.loadChunk(Math.max(0, Math.min(msg.offset, this.state.fileSize - 1))); break;
      case "analyse": await this.analyseAt(msg.offset ?? this.state.currentOffset); break;
      case "closeAnalyse": this.post("closeAnalyse"); break;
      case "theme": this.sendTheme(); break;
      case "setViewMode": this.changeViewMode(msg.mode); break;
      case "setSkipMode": this.state.skipMode = msg.mode; this.post("skipMode", { mode: this.state.skipMode }); break;
      case "toggleWrap": this.state.wrapEnabled = !this.state.wrapEnabled; this.post("wrap", { enabled: this.state.wrapEnabled }); break;
      case "nextPage": await this.nextPage(); break;
      case "prevPage": await this.loadChunk(Math.max(0, this.state.currentOffset - CHUNK_SIZE)); break;
      case "goTop": this.state.sequential = false; await this.loadChunk(0); break;
      case "goBottom": this.state.sequential = false; await this.loadChunk(Math.max(0, this.state.fileSize - CHUNK_SIZE)); break;
      case "jumpReadable": await this.jumpToNext("readable"); break;
      case "jumpUnreadable": await this.jumpToNext("unreadable"); break;
      case "abortScan": this.cancelScan(); this.post("scanAborted"); break;
      case "toggleSlider": this.post("toggleSlider"); break;
      case "closeSlider": this.post("closeSlider"); break;
      case "sliderSeek": this.state.sequential = false; await this.loadChunk(msg.offset); break;
      case "fontSlider": this.post("fontSize", { size: msg.value }); break;
    }
  }

  // ---- File I/O ----

  private async readFileRange(offset: number, size: number): Promise<Buffer> {
    if (this.state.fd === null) return Buffer.alloc(0);
    if (offset >= this.state.fileSize) return Buffer.alloc(0);
    const clampedOffset = Math.min(offset, this.state.fileSize - 1);
    const clampedSize = Math.min(size, this.state.fileSize - clampedOffset);
    if (clampedSize <= 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(clampedSize);
    try {
      const bytesRead = await new Promise<number>((res, rej) =>
        fs.read(this.state.fd!, buf, 0, clampedSize, clampedOffset, (err, b) => err ? rej(err) : res(b))
      );
      return buf.slice(0, bytesRead);
    } catch (err: any) {
      console.error(`[ExaPager] read error at ${offset}:`, err.message);
      return Buffer.alloc(0);
    }
  }

  // ---- Chunk loading ----

  public async loadChunk(offset: number): Promise<void> {
    this.cancelScan();
    const seq = ++this.state.loadSeq;
    try {
      this.state.currentOffset = offset;
      const raw = await this.readFileRange(offset, CHUNK_SIZE);
      if (seq !== this.state.loadSeq) return;
      if (raw.length === 0) {
        this.post("chunk", { data: "[End of file]", offset, size: 0, stats: null, fileSize: this.state.fileSize, encoding: this.state.encoding, rejected: false, lines: [], startLine: this.state.startLine });
        return;
      }

        const text = iconv.decode(raw, this.state.encoding).toString();
        const stats = chunkStats(raw, text);

      // Auto-detect better encoding
      let usedEncoding = this.state.encoding;
      let rawText = text;
      if (stats && stats.replacedPct > 5) {
        const best = stats.bestEncoding;
        if (best && best !== this.state.encoding) {
          try {
            const altText = iconv.decode(raw, best).toString();
            if ((altText.match(/\ufffd/g) || []).length < raw.length * 0.05) {
              usedEncoding = best;
              rawText = altText;
            }
          } catch { /* encoding not supported */ }
        }
      }

      const isReadable = stats ? stats.isReadable : true;
      const lines = rawText.split("\n");
      if (!rawText.endsWith("\n")) lines.pop();

      // Line tracking
      if (this.state.sequential && offset > 0) {
        this.state.startLine = this.state.totalLinesSeen + 1;
      } else if (offset === 0) {
        this.state.startLine = 1;
        this.state.totalLinesSeen = 0;
      } else {
        this.state.startLine = this.state.avgLineLen > 0 ? Math.floor(offset / this.state.avgLineLen) + 1 : 1;
      }
      this.state.totalLinesSeen = this.state.startLine + lines.length - 1;
      if (this.state.avgLineLen === 0 && lines.length > 0) {
        this.state.avgLineLen = Math.max(10, rawText.length / lines.length);
      }
      this.state.sequential = false;

      const escapedLines = lines.map(l => escapeHtml(l));

      this.post("chunk", {
        data: escapedLines.join("\n"), offset, size: raw.length, stats,
        fileSize: this.state.fileSize, encoding: usedEncoding,
        rejected: !isReadable, lines: escapedLines, startLine: this.state.startLine,
        decodedEncoding: usedEncoding !== this.state.encoding ? usedEncoding : null,
        rawText: rawText,
      });

      // Hex view: also send hex dump
      if (this.state.viewMode === "hex") await this.hexDump(offset);
    } catch (err: any) {
      if (seq === this.state.loadSeq) {
        this.post("status", { text: `Error: ${err?.message ?? String(err)}` });
        vscode.window.showErrorMessage(`ExaPager: read error at offset ${offset}`);
      }
    }
  }

  private async hexDump(offset: number): Promise<void> {
    try {
      const raw = await this.readFileRange(offset, HEX_DUMP_SIZE);
      const lines = hexDump(raw, offset);
      this.post("hex", { data: lines.join("\n"), offset, size: raw.length, fileSize: this.state.fileSize });
    } catch (err: any) {
      vscode.window.showErrorMessage(`ExaPager: hex error at ${offset}`);
    }
  }

  // ---- Search ----

  private async search(query: string, _wholeFile: boolean): Promise<void> {
    if (!query || this.state.fd === null) return;
    this.cancelScan();
    const controller = new AbortController();
    this.state.scanController = controller;
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const matches: number[] = [];
      const q = query.toLowerCase();
      let pos = 0;
      let lastProgress = 0;
      while (pos < this.state.fileSize && matches.length < 100) {
        if (controller.signal.aborted) break;
        const readSize = Math.min(SEARCH_WINDOW, this.state.fileSize - pos);
        if (readSize <= 0) break;
        const raw = await this.readFileRange(pos, readSize);
        if (raw.length === 0) break;
        const text = iconv.decode(raw, this.state.encoding).toString().toLowerCase();
        let idx = 0;
        while ((idx = text.indexOf(q, idx)) !== -1) {
          if (matches.length >= 100) break;
          matches.push(pos + idx);
          idx++;
        }
        pos += readSize;
        const progress = Math.round((pos / this.state.fileSize) * 100);
        if (progress !== lastProgress) { lastProgress = progress; this.post("searchProgress", { progress }); }
      }
      clearTimeout(timeout);
      if (!controller.signal.aborted) {
        this.post("searchResult", { matches, count: matches.length, query, scanned: pos });
      }
    } catch (err: any) {
      clearTimeout(timeout);
      this.post("status", { text: `Search error: ${err?.message ?? String(err)}` });
      vscode.window.showErrorMessage("ExaPager: search error");
    } finally { this.state.scanController = null; }
  }

  // ---- Analyse ----

  public async analyseAt(offset: number) {
    try {
      const raw = await this.readFileRange(offset, 32 * 1024);
      if (raw.length === 0) { this.post("analyseError", { error: "EOF" }); return; }
      const text = iconv.decode(raw, this.state.encoding).toString();
      const filtered = filterText(text);
      const analysis = analyseChunk(raw, offset);
      this.post("analyse", { data: { ...analysis, filteredPreview: filtered.slice(0, 500), filterApplied: "control chars stripped, whitespace collapsed, HTML unescaped" } });
    } catch (err: any) {
      this.post("analyseError", { error: err?.message ?? String(err) });
    }
  }

  // ---- Navigation with skip ----

  public async nextPage(): Promise<void> {
    let off = this.state.currentOffset + CHUNK_SIZE;
    if (off >= this.state.fileSize) { vscode.window.showWarningMessage("ExaPager: At end of file"); return; }
    if (this.state.skipMode !== "off") {
      const res = await this.scanForMode(off, this.state.skipMode);
      if (res.cancelled) { this.post("scanAborted"); return; }
      if (!res.found) { vscode.window.showWarningMessage(`ExaPager: No ${this.state.skipMode} content found`); return; }
      off = res.offset;
    }
    this.state.sequential = true;
    await this.loadChunk(off);
  }

  private async jumpToNext(mode: "readable" | "unreadable"): Promise<void> {
    const from = this.state.currentOffset + CHUNK_SIZE;
    if (from >= this.state.fileSize) { vscode.window.showWarningMessage("ExaPager: At end of file"); return; }
    const res = await this.scanForMode(from, mode);
    if (res.cancelled) { this.post("scanAborted"); return; }
    if (!res.found) { vscode.window.showWarningMessage(`ExaPager: No ${mode} content found`); return; }
    this.state.sequential = false;
    await this.loadChunk(res.offset);
  }

  private async scanForMode(fromOffset: number, mode: "readable" | "unreadable"): Promise<{ found: boolean; offset: number; cancelled: boolean }> {
    this.cancelScan();
    const controller = new AbortController();
    this.state.scanController = controller;
    const timeout = setTimeout(() => controller.abort(), ABORT_TIMEOUT);
    const wantReadable = mode === "readable";
    let lastProgress = 0;
    const progressInterval = setInterval(() => { if (!controller.signal.aborted) this.post("scanProgress", { progress: lastProgress }); }, 300);
    try {
      let pos = fromOffset;
      while (pos < this.state.fileSize) {
        if (controller.signal.aborted) { clearInterval(progressInterval); clearTimeout(timeout); return { found: false, offset: pos, cancelled: true }; }
        const raw = await this.readFileRange(pos, CHUNK_SIZE);
        if (raw.length === 0) break;
      const text = iconv.decode(raw, this.state.encoding).toString();
        const stats = chunkStats(raw, text);
        const readable = stats ? stats.isReadable : true;
        lastProgress = Math.round((pos / this.state.fileSize) * 100);
        if (readable === wantReadable) { clearInterval(progressInterval); clearTimeout(timeout); return { found: true, offset: pos, cancelled: false }; }
        pos += SCAN_STEP;
      }
      clearInterval(progressInterval); clearTimeout(timeout);
      return { found: false, offset: pos, cancelled: false };
    } finally { this.state.scanController = null; }
  }

  // ---- View mode ----

  private changeViewMode(mode: ViewMode) {
    this.state.viewMode = mode;
    this.post("viewMode", { mode });
    this.loadChunk(this.state.currentOffset);
  }

  // ---- Scan control ----

  public get currentOffset(): number { return this.state.currentOffset; }
  public get wrapEnabled(): boolean { return this.state.wrapEnabled; }
  public set wrapEnabled(v: boolean) { this.state.wrapEnabled = v; }

  public cancelScan() {
    if (this.state.scanController) { this.state.scanController.abort(); this.state.scanController = null; }
  }

  // ---- Messaging ----

  private sendTheme() {
    const kind = vscode.window.activeColorTheme.kind;
    const dark = { bg: "#1e1e1e", bg2: "#252526", bg3: "#2d2d2d", bg4: "#333333", fg: "#cccccc", fg2: "#969696", fg3: "#666666", accent: "#007acc", accent2: "#0e639c", green: "#4ec9b0", red: "#f44747", orange: "#ce9178", yellow: "#dcdcaa", blue: "#569cd6", border: "#444", statusbar: "#007acc", linehl: "#2a2d2e", gutter: "#3c3c3c", matchhl: "#ff000066" };
    const light = { bg: "#ffffff", bg2: "#f3f3f3", bg3: "#efefef", bg4: "#ececec", fg: "#333333", fg2: "#717171", fg3: "#9a9a9a", accent: "#007acc", accent2: "#005a9e", green: "#008000", red: "#c41a16", orange: "#d7ba73", yellow: "#795e26", blue: "#001080", border: "#e8e8e8", statusbar: "#007acc", linehl: "#f0f0f0", gutter: "#f5f5f5", matchhl: "#ff000022" };
    const hc = { bg: "#000000", bg2: "#000000", bg3: "#000000", bg4: "#000000", fg: "#ffffff", fg2: "#ffffff", fg3: "#ffffff", accent: "#00ffff", accent2: "#00cccc", green: "#00ff00", red: "#ff0000", orange: "#ff8c00", yellow: "#ffff00", blue: "#00ffff", border: "#ffffff", statusbar: "#00ffff", linehl: "#333333", gutter: "#000000", matchhl: "#ffffff33" };
    const palette = kind === 2 ? light : kind === 3 ? hc : dark;
    this.post("theme", { colors: palette });
  }

  public post(cmd: string, data: Record<string, any> = {}): void {
    this.panel.webview.postMessage({ cmd, ...data });
  }

  private showError(message: string): void {
    this.panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;font-family:monospace;background:#1e1e1e;color:#ccc}.err{text-align:center;font-size:14px;padding:20px}</style></head><body><div class="err">${escapeHtml(message)}</div></body></html>`;
    vscode.window.showErrorMessage(`ExaPager: ${message}`);
  }

  // ---- Dispose ----

  public dispose() {
    this.cancelScan();
    vscode.commands.executeCommand("setContext", "exapager.active", false);
    if (this.state.fd !== null) { try { fs.closeSync(this.state.fd); } catch { /* already closed */ } this.state.fd = null; }
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
    if (ExaPagerPanel.currentPanel === this) ExaPagerPanel.currentPanel = undefined;
  }
}

// ---- Activation ----

export function activate(context: vscode.ExtensionContext): void {
  // Helper to get current panel
  const getPanel = () => ExaPagerPanel.currentPanel;

  context.subscriptions.push(
    vscode.commands.registerCommand("exapager.open", () => {
      vscode.window.showOpenDialog({ openLabel: "Open with ExaPager", canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { Text: ["txt", "text", "log", "csv", "json", "xml", "html", "md"], All: ["*"] } })
        .then(uris => { if (uris?.[0]) ExaPagerPanel.render(context.extensionUri, uris[0].fsPath); });
    }),
    vscode.commands.registerCommand("exapager.openActive", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc?.uri.scheme === "file") ExaPagerPanel.render(context.extensionUri, doc.uri.fsPath);
      else vscode.window.showErrorMessage("No active file.");
    }),
    vscode.commands.registerCommand("exapager.previewFile", (uri: vscode.Uri) => {
      if (uri?.scheme === "file") ExaPagerPanel.render(context.extensionUri, uri.fsPath);
      else {
        const doc = vscode.window.activeTextEditor?.document;
        if (doc?.uri.scheme === "file") ExaPagerPanel.render(context.extensionUri, doc.uri.fsPath);
        else vscode.window.showErrorMessage("No file to preview.");
      }
    }),
    // Keybinding commands
    vscode.commands.registerCommand("exapager.focusSearch", () => { getPanel()?.post("focusSearch"); }),
    vscode.commands.registerCommand("exapager.focusOffset", () => { getPanel()?.post("focusOffset"); }),
    vscode.commands.registerCommand("exapager.toggleWrap", () => {
      const p = getPanel();
      if (p) { p.wrapEnabled = !p.wrapEnabled; p.post("wrap", { enabled: p.wrapEnabled }); }
    }),
    vscode.commands.registerCommand("exapager.reloadChunk", () => {
      const p = getPanel(); if (p) p.loadChunk(p.currentOffset);
    }),
    vscode.commands.registerCommand("exapager.nextPage", () => { getPanel()?.nextPage(); }),
    vscode.commands.registerCommand("exapager.prevPage", () => {
      const p = getPanel();
      if (p) p.loadChunk(Math.max(0, p.currentOffset - CHUNK_SIZE));
    }),
    vscode.commands.registerCommand("exapager.abortOperation", () => {
      const p = getPanel();
      if (p) { p.cancelScan(); p.post("scanAborted"); }
    }),
    vscode.commands.registerCommand("exapager.toggleSlider", () => { getPanel()?.post("toggleSlider"); }),
    vscode.commands.registerCommand("exapager.analyseChunk", () => {
      const p = getPanel();
      if (p) p.analyseAt(p.currentOffset);
    }),
  );
}

export function deactivate(): void {
  ExaPagerPanel.currentPanel?.dispose();
}
