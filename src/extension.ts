import * as path from "path";
import * as vscode from "vscode";
import * as fsNode from "fs";
import {
  CHUNK_SIZE, HEX_DUMP_SIZE, SEARCH_WINDOW, SKIP_STEP, SCAN_STEP,
  filterText, chunkStats, escapeHtml, formatOffset, formatSize,
  hexRow, hexDump, probeEncoding, analyseChunk, findBadRanges,
  computeByteClasses, isReadableChunk
} from "./utils";

const ABORT_TIMEOUT = 8000;

type ViewMode = "text" | "hex" | "raw";
type SkipMode = "off" | "readable" | "unreadable";

class ExaPagerPanel {
  public static currentPanel: ExaPagerPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly filePath: string;
  private disposeHandlers: vscode.Disposable[] = [];
  private fd: number | null = null;
  private fileSize: number = 0;
  private currentOffset: number = 0;
  private viewMode: ViewMode = "text";
  private encoding: string = "utf-8";
  private wrapEnabled: boolean = true;
  private skipMode: SkipMode = "off";
  private scanController: AbortController | null = null;
  private loadSeq: number = 0;
  private avgLineLen: number = 0;
  private totalLinesSeen: number = 0;
  private startLine: number = 1;
  private sequential: boolean = true;

  private constructor(panel: vscode.WebviewPanel, filePath: string) {
    this.panel = panel;
    this.filePath = filePath;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposeHandlers);
    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.viewColumn === undefined) this.dispose();
    }, null, this.disposeHandlers);
    vscode.window.onDidChangeActiveColorTheme(() => this.sendTheme(), null, this.disposeHandlers);

    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage(
      async (msg) => await this.handleMessage(msg),
      undefined,
      this.disposeHandlers
    );

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

    const panel = vscode.window.createWebviewPanel(
      "exapager",
      `ExaPager: ${path.basename(filePath)}`,
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    ExaPagerPanel.currentPanel = new ExaPagerPanel(panel, filePath);
  }

  private async init() {
    try {
      const stat = await new Promise<fsNode.Stats>((res, rej) =>
        fsNode.stat(this.filePath, (err, s) => (err ? rej(err) : res(s)))
      );
      this.fileSize = stat.size;
      this.fd = await new Promise<number>((res, rej) =>
        fsNode.open(this.filePath, "r", (err, f) => (err ? rej(err) : res(f)))
      );
      this.sendTheme();
      this.sendFileInfo();
      await this.loadChunk(0);
    } catch (err) {
      this.showError(
        `Failed to open file: ${err && typeof err === "object" && "message" in err ? err.message : String(err)}`
      );
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    console.error(`[ExaPager←webview] ${msg.cmd}`);
    switch (msg.cmd) {
      case "loadChunk":
        await this.loadChunk(msg.offset);
        break;
      case "hexDump":
        await this.hexDump(msg.offset);
        break;
      case "search":
        await this.search(msg.query, msg.from, msg.wholeFile);
        break;
      case "searchNext":
        await this.searchNext();
        break;
      case "skip":
        await this.skip(msg.offset);
        break;
      case "analyse":
        await this.analyseAt(msg.offset ?? this.currentOffset);
        break;
      case "closeAnalyse":
        this.postMessage({ cmd: "closeAnalyse" });
        break;
      case "theme":
        this.sendTheme();
        break;
      case "setViewMode":
        this.setViewMode(msg.mode);
        break;
      case "setSkipMode":
        this.skipMode = msg.mode;
        this.postMessage({ cmd: "skipMode", mode: this.skipMode });
        break;
      case "toggleWrap":
        this.toggleWrap();
        break;
      case "nextPage":
        this.nextPage();
        break;
      case "prevPage":
        this.prevPage();
        break;
      case "goTop":
        await this.goTop();
        break;
      case "goBottom":
        await this.goBottom();
        break;
      case "jumpReadable":
        await this.jumpToNext("readable");
        break;
      case "jumpUnreadable":
        await this.jumpToNext("unreadable");
        break;
      case "abortScan":
        this.cancelScan();
        this.postMessage({ cmd: "scanAborted" });
        break;
      case "toggleSlider":
        this.postMessage({ cmd: "toggleSlider" });
        break;
      case "closeSlider":
        this.postMessage({ cmd: "closeSlider" });
        break;
      case "sliderSeek":
        await this.skip(msg.offset);
        break;
      case "fontSlider":
        this.postMessage({ cmd: "fontSize", size: msg.value });
        break;
    }
  }

   private async readFileRange(offset: number, size: number): Promise<Buffer> {
    if (this.fd === null) return Buffer.alloc(0);
    // Clamp to valid range for large files
    if (offset >= this.fileSize) return Buffer.alloc(0);
    const clampedOffset = Math.min(offset, this.fileSize - 1);
    const clampedSize = Math.min(size, this.fileSize - clampedOffset);
    if (clampedSize <= 0) return Buffer.alloc(0);
    const buf = Buffer.alloc(clampedSize);
    const fd = this.fd;
    try {
      const { bytesRead } = await new Promise<{ bytesRead: number }>((res, rej) => {
        fsNode.read(fd, buf, 0, clampedSize, clampedOffset, (err, b) => (err ? rej(err) : res({ bytesRead: b })));
      });
      return buf.slice(0, bytesRead);
    } catch (err) {
      console.error(`[ExaPager] readFileRange failed at offset ${offset}:`, err);
      return Buffer.alloc(0);
    }
  }

  private async loadChunk(offset: number): Promise<void> {
    this.cancelScan();
    const seq = ++this.loadSeq;
    try {
      this.currentOffset = offset;
      const raw = await this.readFileRange(offset, CHUNK_SIZE);
      if (seq !== this.loadSeq) return; // stale, skip
      if (raw.length === 0) {
        this.postMessage({ cmd: "chunk", data: "[End of file]", offset, size: 0, stats: null, fileSize: this.fileSize, encoding: this.encoding, rejected: false, lines: [], startLine: this.startLine });
        return;
      }

      const utf8Text = raw.toString(this.encoding as BufferEncoding);
      const stats = chunkStats(raw, utf8Text);

      // If UTF-8 has many replacements, try probe's best encoding
      let usedEncoding = this.encoding;
      let rawText = utf8Text;
      if (stats && stats.replacedPct > 5) {
        const best = stats.bestEncoding;
        if (best && best !== "utf-8") {
          try {
            const altText = raw.toString(best as BufferEncoding);
            const altBad = (altText.match(/[\ufffd]/g) || []).length;
            if (altBad < raw.length * 0.05) {
              usedEncoding = best;
              rawText = altText;
            }
          } catch (err) {
            console.error(`[ExaPager] Alternate encoding "${best}" failed:`, err);
          }
        }
      }

      const filtered = filterText(rawText);
      const isReadable = stats ? stats.isReadable : true;
      const rejected = stats ? !stats.isReadable : false;

      // Compute lines for text view
      const lines = rawText.split("\n");
      if (lines.length > 0 && !rawText.endsWith("\n")) lines.pop();

      // Line tracking like Python version
      if (this.sequential && offset > 0) {
        this.startLine = this.totalLinesSeen + 1;
      } else if (offset === 0) {
        this.startLine = 1;
        this.totalLinesSeen = 0;
      } else {
        this.startLine = this.avgLineLen > 0 ? Math.floor(offset / this.avgLineLen) + 1 : 1;
      }
      this.totalLinesSeen = this.startLine + lines.length - 1;
      if (this.avgLineLen === 0 && lines.length > 0) {
        this.avgLineLen = Math.max(10, rawText.length / lines.length);
      }
      this.sequential = false;

      // Escape each line for HTML
      const escapedLines = lines.map(line => escapeHtml(line));

      this.postMessage({
        cmd: "chunk",
        data: escapedLines.join("\n"),
        offset,
        size: raw.length,
        stats,
        fileSize: this.fileSize,
        encoding: usedEncoding,
        rejected,
        lines: escapedLines,
        startLine: this.startLine,
        decodedEncoding: usedEncoding !== this.encoding ? usedEncoding : null,
      });

      // If hex mode, also send hex dump
      if (this.viewMode === "hex") {
        await this.hexDump(offset);
      }

      // If raw mode, render raw bytes as hex + ascii
      if (this.viewMode === "raw") {
        this.postMessage({
          cmd: "raw",
          data: raw.toString("hex"),
          offset,
          size: raw.length,
          fileSize: this.fileSize,
        });
      }
    } catch (err) {
      console.error(`[ExaPager] loadChunk failed at offset ${offset}:`, err);
      if (seq === this.loadSeq) {
        this.postMessage({
          cmd: "status",
          text: `Error: ${err && typeof err === "object" && "message" in err ? err.message : String(err)}`,
        });
        vscode.window.showErrorMessage(`ExaPager: read error at offset ${offset}`);
      }
    }
  }

  private async hexDump(offset: number): Promise<void> {
    try {
      const raw = await this.readFileRange(offset, HEX_DUMP_SIZE);
      const lines = hexDump(raw, offset);
      this.postMessage({
        cmd: "hex",
        data: lines.join("\n"),
        offset,
        size: raw.length,
        fileSize: this.fileSize,
      });
    } catch (err) {
      console.error(`[ExaPager] hexDump failed at offset ${offset}:`, err);
      vscode.window.showErrorMessage(`ExaPager: hex read error at offset ${offset}`);
    }
  }

   private async search(query: string, from: number | undefined, _wholeFile: boolean): Promise<void> {
    if (!query || this.fd === null) return;
    this.cancelScan();
    const controller = new AbortController();
    this.scanController = controller;
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const matches: number[] = [];
      const q = query.toLowerCase();
      let pos = 0;

      while (pos < this.fileSize && matches.length < 100) {
        if (controller.signal.aborted) break;
        const readSize = Math.min(SEARCH_WINDOW, this.fileSize - pos);
        if (readSize <= 0) break;
        const raw = await this.readFileRange(pos, readSize);
        if (raw.length === 0) break;
        const text = raw.toString(this.encoding as BufferEncoding).toLowerCase();
        let idx = 0;
        while ((idx = text.indexOf(q, idx)) !== -1) {
          if (matches.length >= 100) break;
          matches.push(pos + idx);
          idx++;
        }
        pos += readSize;
      }

      clearTimeout(timeout);
      this.postMessage({ cmd: "searchResult", matches, count: matches.length, query, scanned: pos });
    } catch (err) {
      console.error(`[ExaPager] search failed for "${query}":`, err);
      clearTimeout(timeout);
      this.postMessage({
        cmd: "status",
        text: `Search error: ${err && typeof err === "object" && "message" in err ? err.message : String(err)}`,
      });
      vscode.window.showErrorMessage(`ExaPager: search error`);
    } finally {
      this.scanController = null;
    }
  }

  private async searchNext(): Promise<void> {
    // handled in webview
  }

  private async skip(offset: number): Promise<void> {
    this.sequential = false;
    offset = Math.max(0, Math.min(offset, this.fileSize - 1));
    await this.loadChunk(offset);
  }

  // Analyse at current offset (LOCAL, not always 0)
  private async analyseAt(offset: number) {
    try {
      const raw = await this.readFileRange(offset, 32 * 1024);
      if (raw.length === 0) {
        this.postMessage({ cmd: "analyseError", error: "EOF at offset" });
        return;
      }
      const text = raw.toString(this.encoding as BufferEncoding);
      const filtered = filterText(text);
      const analysis = analyseChunk(raw, offset);

      this.postMessage({
        cmd: "analyse",
        data: {
          ...analysis,
          filteredPreview: filtered.slice(0, 500),
          filterApplied: "control chars stripped, whitespace collapsed, HTML unescaped",
        },
      });
    } catch (err) {
      console.error(`[ExaPager] analyse failed at offset ${offset}:`, err);
      const msg = err && typeof err === "object" && "message" in err ? err.message : String(err);
      this.postMessage({ cmd: "analyseError", error: msg });
    }
  }

  // --- Navigation with skip filter ---

  private async nextPage(): Promise<void> {
    let off = this.currentOffset + CHUNK_SIZE;
    if (off >= this.fileSize) {
      vscode.window.showWarningMessage("ExaPager: At end of file");
      return;
    }

    // Apply skip filter
    if (this.skipMode !== "off") {
      const res = await this.scanForMode(off, this.skipMode);
      if (res.cancelled) {
        this.postMessage({ cmd: "scanAborted" });
        return;
      }
      if (!res.found) {
        vscode.window.showWarningMessage(`ExaPager: No ${this.skipMode} content found to end of file`);
        return;
      }
      off = res.offset;
    }

    this.sequential = true;
    await this.loadChunk(off);
  }

  private async prevPage(): Promise<void> {
    const off = Math.max(0, this.currentOffset - CHUNK_SIZE);
    await this.loadChunk(off);
  }

  private async goTop(): Promise<void> {
    this.sequential = false;
    await this.loadChunk(0);
  }

  private async goBottom(): Promise<void> {
    this.sequential = false;
    await this.loadChunk(Math.max(0, this.fileSize - CHUNK_SIZE));
  }

  // Jump to next readable/unreadable (one-shot, doesn't change skipMode)
  private async jumpToNext(mode: "readable" | "unreadable"): Promise<void> {
    const from = this.currentOffset + CHUNK_SIZE;
    if (from >= this.fileSize) {
      vscode.window.showWarningMessage("ExaPager: At end of file");
      return;
    }
    const res = await this.scanForMode(from, mode);
    if (res.cancelled) {
      this.postMessage({ cmd: "scanAborted" });
      return;
    }
    if (!res.found) {
      vscode.window.showWarningMessage(`ExaPager: No ${mode} content found to end of file`);
      return;
    }
    this.sequential = false;
    await this.loadChunk(res.offset);
  }

  private async scanForMode(fromOffset: number, mode: "readable" | "unreadable"): Promise<
    { found: boolean; offset: number; cancelled: boolean }
  > {
    this.cancelScan();
    const controller = new AbortController();
    this.scanController = controller;
    const timeout = setTimeout(() => controller.abort(), ABORT_TIMEOUT);
    const wantReadable = mode === "readable";

    // Progress polling
    let lastProgress = 0;
    const progressInterval = setInterval(() => {
      if (controller.signal.aborted) return;
      this.postMessage({ cmd: "scanProgress", progress: lastProgress });
    }, 300);

    try {
      let pos = fromOffset;
      while (pos < this.fileSize) {
        if (controller.signal.aborted) {
          clearInterval(progressInterval);
          clearTimeout(timeout);
          return { found: false, offset: pos, cancelled: true };
        }
        const raw = await this.readFileRange(pos, CHUNK_SIZE);
        if (raw.length === 0) break;
        const text = raw.toString(this.encoding as BufferEncoding);
        const stats = chunkStats(raw, text);
        const readable = stats ? stats.isReadable : true;
        lastProgress = Math.round((pos / this.fileSize) * 100);

        if (readable === wantReadable) {
          clearInterval(progressInterval);
          clearTimeout(timeout);
          this.postMessage({ cmd: "scanDone", found: true, offset: pos });
          return { found: true, offset: pos, cancelled: false };
        }
        pos += SCAN_STEP;
      }
      clearInterval(progressInterval);
      clearTimeout(timeout);
      return { found: false, offset: pos, cancelled: false };
    } finally {
      this.scanController = null;
    }
  }

  private cancelScan() {
    if (this.scanController) {
      this.scanController.abort();
      this.scanController = null;
    }
  }

  private setViewMode(mode: ViewMode) {
    this.viewMode = mode;
    this.postMessage({ cmd: "viewMode", mode });
    this.loadChunk(this.currentOffset);
  }

  private toggleWrap() {
    this.wrapEnabled = !this.wrapEnabled;
    this.postMessage({ cmd: "wrap", enabled: this.wrapEnabled });
  }

  private sendTheme() {
    const kind = vscode.window.activeColorTheme.kind;
    const dark = { bg: "#1e1e1e", bg2: "#252526", bg3: "#2d2d2d", bg4: "#333333", fg: "#cccccc", fg2: "#969696", fg3: "#666666", accent: "#007acc", accent2: "#0e639c", green: "#4ec9b0", red: "#f44747", orange: "#ce9178", yellow: "#dcdcaa", blue: "#569cd6", border: "#444", statusbar: "#007acc", linehl: "#2a2d2e", gutter: "#3c3c3c", matchhl: "#ff000066" };
    const light = { bg: "#ffffff", bg2: "#f3f3f3", bg3: "#efefef", bg4: "#ececec", fg: "#333333", fg2: "#717171", fg3: "#9a9a9a", accent: "#007acc", accent2: "#005a9e", green: "#008000", red: "#c41a16", orange: "#d7ba73", yellow: "#795e26", blue: "#001080", border: "#e8e8e8", statusbar: "#007acc", linehl: "#f0f0f0", gutter: "#f5f5f5", matchhl: "#ff000022" };
    const hc = { bg: "#000000", bg2: "#000000", bg3: "#000000", bg4: "#000000", fg: "#ffffff", fg2: "#ffffff", fg3: "#ffffff", accent: "#00ffff", accent2: "#00cccc", green: "#00ff00", red: "#ff0000", orange: "#ff8c00", yellow: "#ffff00", blue: "#00ffff", border: "#ffffff", statusbar: "#00ffff", linehl: "#333333", gutter: "#000000", matchhl: "#ffffff33" };
    const palette = kind === 2 ? light : kind === 3 ? hc : dark;
    this.postMessage({ cmd: "theme", colors: palette });
  }

  private sendFileInfo() {
    this.postMessage({
      cmd: "fileInfo",
      name: path.basename(this.filePath),
      size: this.fileSize,
    });
  }

  private postMessage(msg: any): void {
    console.error(`[ExaPager→webview] ${msg.cmd}`, msg.cmd === 'chunk' ? (`offset=${msg.offset}, lines=` + (msg.lines ? msg.lines.length : 0) + `, stats=` + !!msg.stats) : '');
    this.panel.webview.postMessage(msg);
  }

  private showError(message: string): void {
    this.panel.webview.html = this.getErrorHtml(message);
    vscode.window.showErrorMessage(`ExaPager: ${message}`);
  }

  private getErrorHtml(message: string): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>html,body{margin:0;padding:0;height:100%;display:flex;align-items:center;justify-content:center;font-family:monospace;background:#1e1e1e;color:#cccccc}.err{text-align:center;font-size:14px;padding:20px}</style></head><body><div class="err">${escapeHtml(message)}</div></body></html>`;
  }

  private getHtml() {
    const fileName = escapeHtml(path.basename(this.filePath));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#1e1e1e;--bg2:#252526;--bg3:#2d2d2d;--bg4:#333333;
  --fg:#cccccc;--fg2:#969696;--fg3:#666666;
  --accent:#007acc;--accent2:#0e639c;
  --green:#4ec9b0;--red:#f44747;--orange:#ce9178;--yellow:#dcdcaa;--blue:#569cd6;
  --border:#444;--statusbar:#007acc;--linehl:#2a2d2e;--gutter:#3c3c3c;
  --matchhl:#ff000066;
}
html,body{height:100%;font-family:Consolas,'Courier New',monospace;font-size:14px;background:var(--bg);color:var(--fg);overflow:hidden}
#app{display:flex;flex-direction:column;height:100vh}

#main{display:flex;flex:1;overflow:hidden}

#sidebar{width:280px;background:var(--bg2);border-right:1px solid var(--border);padding:8px;overflow-y:auto;flex-shrink:0;display:flex;flex-direction:column;gap:8px}
#sidebar h3{color:var(--fg2);font-size:10px;text-transform:uppercase;letter-spacing:1px;padding:2px 0}
.ctrl-group{display:flex;flex-direction:column;gap:4px}
.ctrl-row{display:flex;gap:4px;align-items:center}
.ctrl-row label{color:var(--fg2);font-size:11px;min-width:48px}
input[type=text],input[type=number],select{background:var(--bg4);color:var(--fg);border:1px solid var(--border);padding:3px 5px;font-size:11px;font-family:inherit;outline:none;border-radius:2px}
input:focus,select:focus{border-color:var(--accent)}
button{background:var(--bg4);color:var(--fg);border:1px solid var(--border);padding:3px 8px;font-size:11px;font-family:inherit;cursor:pointer;border-radius:2px;white-space:nowrap}
button:hover{background:var(--accent2);border-color:var(--accent)}
button:active{background:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button.warn{background:#856404;border-color:#856404;color:#fff}
.jump-input{flex:1;min-width:0}

#search-results{max-height:120px;overflow-y:auto;font-size:10px}
#search-results .match-item{padding:2px 6px;cursor:pointer;white-space:nowrap;color:var(--fg2);border-radius:2px}
#search-results .match-item:hover{background:var(--linehl);color:var(--fg)}

#stats-panel{background:var(--bg3);border:1px solid var(--border);border-radius:3px;padding:6px 8px;font-size:10px;display:flex;flex-direction:column;gap:3px}
.stat-row{display:flex;justify-content:space-between;align-items:center}
.stat-label{color:var(--fg2)}
.stat-value{color:var(--fg);font-weight:bold}
.stat-value.good{color:var(--green)}
.stat-value.warn{color:var(--yellow)}
.stat-value.bad{color:var(--red)}
.stat-bar{height:4px;background:var(--bg4);border-radius:2px;overflow:hidden;margin-top:1px}
.stat-bar-fill{height:100%;border-radius:2px}
.enc-probe{color:var(--fg3);font-size:9px;padding-left:4px}

.rejected-banner{position:absolute;top:0;left:0;right:0;z-index:10;background:rgba(244,71,71,0.12);border-bottom:1px solid rgba(244,71,71,0.3);padding:6px 10px;font-size:11px}
.rejected-banner h4{color:var(--red);margin-bottom:4px}

#editor{flex:1;display:flex;flex-direction:column;overflow:hidden}
#tabbar{height:26px;background:var(--bg2);display:flex;align-items:center;border-bottom:1px solid var(--border);flex-shrink:0}
.tab{height:100%;display:flex;align-items:center;padding:0 10px;font-size:11px;background:var(--bg);color:var(--fg);border-right:1px solid var(--border)}
.tab .mode{color:var(--orange);margin-left:6px;font-size:10px}

#editor-body{flex:1;display:flex;overflow:hidden;position:relative}
#gutter{width:5ch;background:var(--gutter);color:var(--fg2);text-align:right;padding:6px 5px 6px 0;overflow:hidden;flex-shrink:0;user-select:none;line-height:1.6;font-size:13px}
#text-area{flex:1;overflow:auto;padding:6px 10px;line-height:1.6;white-space:pre-wrap;word-break:break-all;font-size:13px;tab-size:2;min-height:1px}

#hex-view{display:none;flex:1;overflow:auto;padding:6px 10px;font-size:12px;line-height:1.4}
#hex-view.show{display:block}
#raw-view{display:none;flex:1;overflow:auto;padding:6px 10px;font-size:12px;line-height:1.4;word-break:break-all}
.hex-addr{color:var(--fg3)}
.hex-bytes{color:var(--fg)}
.hex-ascii{color:var(--green)}

#statusbar{height:20px;background:var(--statusbar);display:flex;align-items:center;padding:0 10px;font-size:10px;color:#fff;flex-shrink:0}
#statusbar .sep{margin:0 8px;opacity:0.5}
#statusbar .right{margin-left:auto}

/* File slider overlay */
#file-scratch{display:none;position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(30,30,30,0.95);z-index:20;padding:20px;flex-direction:column;align-items:center;justify-content:center}
#file-scratch.show{display:flex}
#file-slider-wrap{width:90%;max-width:600px;margin:8px 0}
#file-slider{width:100%;-webkit-appearance:none;appearance:none;height:8px;background:var(--bg4);border-radius:4px;outline:none;cursor:pointer}
#file-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:50%;background:var(--accent);cursor:pointer}
#file-slider::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:var(--accent);cursor:pointer;border:none}
#file-slider-label{color:var(--fg2);font-size:11px;text-align:center}

/* Loading */
#loading{position:absolute;top:0;left:0;right:0;bottom:0;display:none;align-items:center;justify-content:center;background:rgba(30,30,30,0.8);color:var(--fg2);font-size:12px;z-index:10}
#loading.show{display:flex}

/* Scan progress */
#scan-progress-row{display:none}
#scan-bar{height:4px;background:var(--bg4);border-radius:2px;overflow:hidden;display:none}
#scan-bar-fill{height:100%;width:0%;background:var(--accent);border-radius:2px;transition:width 0.3s}

/* Analyse panel */
#analyse-panel{display:none;position:absolute;top:0;left:0;right:0;bottom:0;background:var(--bg);z-index:20;overflow-y:auto;padding:12px}
#analyse-panel.show{display:block}
#analyse-panel h2{color:var(--fg);font-size:14px;margin-bottom:8px}
#analyse-panel .close-btn{position:absolute;top:8px;right:12px;font-size:18px;cursor:pointer;color:var(--fg2)}
#analyse-panel .close-btn:hover{color:var(--fg)}
.anal-section{background:var(--bg2);border:1px solid var(--border);border-radius:3px;padding:8px;margin-bottom:8px}
.anal-section h3{color:var(--fg2);font-size:11px;text-transform:uppercase;margin-bottom:6px}
.anal-section table{width:100%;border-collapse:collapse;font-size:11px}
.anal-section td,.anal-section th{padding:2px 6px;text-align:left;border-bottom:1px solid var(--border)}
.anal-section th{color:var(--fg2);font-weight:normal}
.anal-section .hex-col{color:var(--fg);font-family:monospace}
.anal-section .dec-col{color:var(--green)}
.anal-section .warn-row{background:rgba(244,71,71,0.1)}
.anal-section .info-text{color:var(--fg2);font-size:10px;line-height:1.6}
.anal-section pre{background:var(--bg4);padding:6px;border-radius:2px;font-size:10px;overflow-x:auto;max-height:200px;overflow-y:auto}
.anal-section .badge{display:inline-block;padding:1px 5px;border-radius:2px;font-size:9px;margin:1px}
.anal-section .badge.red{background:rgba(244,71,71,0.3);color:var(--red)}
.anal-section .badge.green{background:rgba(78,201,176,0.3);color:var(--green)}
.anal-section .badge.yellow{background:rgba(212,212,170,0.3);color:var(--yellow)}

.hl-match{background:var(--matchhl)}

::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--bg4);border-radius:4px}
::-webkit-scrollbar-thumb:hover{background:var(--fg3)}
</style>
</head>
<body>
<div id="app">
  <div id="main">
    <div id="sidebar">
      <div class="ctrl-group">
        <h3>Navigate</h3>
        <div class="ctrl-row">
          <label>Offset</label>
          <input type="number" class="jump-input" id="jump-offset" step="1" min="0" placeholder="0">
           <button data-action="jumpToOffset">Go</button>
        </div>
      </div>
       <div class="ctrl-group">
        <h3>View</h3>
        <div class="ctrl-row">
          <button id="btn-text" class="primary" data-view="text">Text</button>
          <button id="btn-hex" data-view="hex">Hex</button>
          <button id="btn-raw" data-view="raw">Raw</button>
        </div>
      </div>
      <div class="ctrl-group">
        <h3>Search</h3>
        <div class="ctrl-row">
          <input type="text" class="jump-input" id="search-q" placeholder="Search...">
          <button data-action="doSearch">Find</button>
        </div>
        <div class="ctrl-row">
          <label>Mode</label>
          <select id="search-mode">
            <option value="window">5MB window</option>
            <option value="all">Whole file</option>
          </select>
        </div>
        <div id="search-results"></div>
      </div>
      <div class="ctrl-group">
        <h3>Page</h3>
        <div class="ctrl-row">
          <button data-action="prevPage">&#9664; Prev</button>
          <button data-action="nextPage">Next &#9654;</button>
        </div>
        <div class="ctrl-row">
          <button data-action="goTop">Top</button>
          <button data-action="goBottom">Bottom</button>
        </div>
        <div class="ctrl-row">
          <label>Auto-skip</label>
           <select id="skip-mode">
            <option value="off">Off</option>
            <option value="readable">Skip unreadable</option>
            <option value="unreadable">Skip readable</option>
          </select>
        </div>
        <div class="ctrl-row">
          <button data-action="jumpReadable">Jump readable</button>
          <button data-action="jumpUnreadable">Jump unreadable</button>
        </div>
        <div class="ctrl-row" id="scan-progress-row">
          <span id="scan-label" style="color:var(--fg2);font-size:10px;flex:1">Scanning...</span>
          <button class="warn" data-action="abortScan" style="font-size:10px">Abort</button>
        </div>
        <div id="scan-bar">
          <div id="scan-bar-fill"></div>
        </div>
        <div class="ctrl-row">
          <button data-action="analyseChunk">Analyse chunk</button>
        </div>
      </div>
      <div class="ctrl-group">
        <h3>Chunk Statistics</h3>
        <div id="stats-panel">
          <div class="stat-row"><span class="stat-label">Loading...</span></div>
        </div>
      </div>
    </div>
    <div id="editor">
      <div id="tabbar">
        <div class="tab">
          <span id="tab-name">${fileName}</span>
          <span class="mode" id="tab-mode">[filtered]</span>
        </div>
      </div>
      <div id="editor-body">
        <div id="gutter"></div>
        <pre id="text-area" tabindex="0"></pre>
        <div id="hex-view"></div>
        <pre id="raw-view"></pre>
        <div id="loading">Loading...</div>
        <div id="analyse-panel"></div>
      </div>
    </div>
  </div>
  <div id="statusbar">
    <span id="st-lines">Ln 1</span>
    <span class="sep">|</span>
    <span id="st-offset">0 / 0</span>
    <span class="sep">|</span>
    <span id="st-range">0-0</span>
    <span class="sep">|</span>
    <span id="st-chars">0 lines</span>
    <span class="sep">|</span>
    <span id="st-filter">filtered</span>
    <span class="right">
      <span id="st-skipmode"></span>
      <span class="sep">|</span>
      <span id="st-readable"></span>
      <span class="sep">|</span>
      <span id="st-encoding">UTF-8</span>
    </span>
    <button data-action="toggleSlider" style="margin-left:8px;font-size:9px;padding:1px 4px" title="File position slider">&#8646;</button>
  </div>
</div>
<div id="file-scratch">
  <div style="color:var(--fg);font-size:13px;margin-bottom:4px">File Position</div>
  <div id="file-slider-label">0 / 0 (0%)</div>
  <div id="file-slider-wrap">
    <input type="range" id="file-slider" min="0" max="100000" value="0">
  </div>
  <div style="color:var(--fg2);font-size:10px;margin-top:4px">Click or drag — press Escape to close</div>
</div>

<script>
try{
(function(){
try{
  console.error('[webview] IIFE started');
  const vs = acquireVsCodeApi();
  const CHUNK = 65536;
  let state = {
    fileSize: 0,
    fileName: '',
    currentOffset: 0,
    searchMatches: [],
    searchQuery: '',
    avgLineLen: 0,
    totalLinesSeen: 0,
    sequential: true,
    viewMode: 'text',
    skipMode: 'off',
    scanCancelled: false,
    stats: null,
    decodedEncoding: null,
    startLine: 1,
  };

  const $ = id => document.getElementById(id);

  function fmtSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }
  function fmtNum(n) { var s = Number(n).toString(); if (s.length <= 3) return s; var r = ''; for (var i = s.length - 1, c = 0; i >= 0; i--, c++) { if (c > 0 && c % 3 === 0) r = ',' + r; r = s[i] + r; } return r; }
  function pctClass(p) { return p > 70 ? 'good' : p > 30 ? 'warn' : 'bad'; }
  function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function send(msg) { vs.postMessage(msg); }

  // Expose on window EARLY (functions are hoisted) so inline onclick handlers work
  window.prevPage = prevPage;
  window.nextPage = nextPage;
  window.goTop = goTop;
  window.goBottom = goBottom;
  window.jumpToNext = jumpToNext;
  window.jumpToOffset = jumpToOffset;
  window.setView = setView;
  window.doSearch = doSearch;
  window.goToMatch = goToMatch;
  window.analyseChunk = analyseChunk;
  window.closeAnalyse = closeAnalyse;
  window.toggleSlider = toggleSlider;
  window.runScanAndNextReadable = runScanAndNextReadable;
  window.abortScan = abortScan;
   window.hideRejectedBanner = hideRejectedBanner;
  window.setSkipMode = setSkipMode;

  // Event delegation for data-action and data-view buttons
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (btn) {
      var action = btn.getAttribute('data-action');
      if (window[action]) { window[action](); return; }
    }
    var vbtn = e.target.closest('[data-view]');
    if (vbtn) {
      var mode = vbtn.getAttribute('data-view');
      if (window.setView) { window.setView(mode); return; }
    }
    var mi = e.target.closest('[data-offset]');
    if (mi) {
      var off = parseInt(mi.getAttribute('data-offset'));
      if (window.goToMatch) { window.goToMatch(off); return; }
    }
  });

  function showLoading(v, msg) {
    const el = $('loading');
    el.className = v ? 'show' : '';
    if (msg) el.textContent = msg;
    else el.textContent = 'Loading...';
  }

  function updateSlider() {
    const sl = $('file-slider');
    if (!state.fileSize) return;
    sl.max = Math.max(1, state.fileSize);
    sl.value = state.currentOffset;
    const pct = state.fileSize > 0 ? ((state.currentOffset / state.fileSize) * 100).toFixed(2) : 0;
    $('file-slider-label').textContent =
      fmtSize(state.currentOffset) + ' / ' + fmtSize(state.fileSize) + ' (' + pct + '%)';
  }

  function toggleSlider() {
    var el = $('file-scratch');
    if (el.className === 'show') { closeSlider(); return; }
    el.className = 'show';
    updateSlider();
    $('file-slider').focus();
  }
  function closeSlider() {
    $('file-scratch').className = '';
  }

  try {
    $('file-slider').addEventListener('input', function(){
      var off = parseInt($('file-slider').value);
      var pct = state.fileSize > 0 ? ((off / state.fileSize) * 100).toFixed(2) : 0;
      $('file-slider-label').textContent =
        fmtSize(off) + ' / ' + fmtSize(state.fileSize) + ' (' + pct + '%)';
    });
    $('file-slider').addEventListener('change', function(){
      var off = parseInt($('file-slider').value);
      state.sequential = false;
      state.currentOffset = off;
      loadChunk(off);
    });
  } catch(e) { console.error('[webview] slider init error', e); }

  function setView(mode) {
    state.viewMode = mode;
    $('btn-text').className = mode === 'text' ? 'primary' : '';
    $('btn-hex').className = mode === 'hex' ? 'primary' : '';
    $('btn-raw').className = mode === 'raw' ? 'primary' : '';
    $('tab-mode').textContent =
      mode === 'text' ? '[filtered]' : mode === 'hex' ? '[hex]' : '[raw]';
    send({ cmd: 'setViewMode', mode });
    loadChunk(state.currentOffset);
  }

  async function loadChunk(offset) {
    showLoading(true);
    send({ cmd: 'loadChunk', offset });
  }

  function showRejectedBanner(stats) {
    hideRejectedBanner();
    $('text-area').style.paddingTop = '40px';
    const bar = document.createElement('div');
    bar.id = 'rejected-banner';
    bar.className = 'rejected-banner';
    bar.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
      '<span style="color:#f44747">&#x26A0; Mixed encoding — text below has invalid UTF-8 stripped</span>' +
      '<span style="color:var(--fg2);font-size:10px">U+FFFD: ' + stats.replacedPct + '% | Printable: ' + stats.printablePct + '% | Cyrillic: ' + stats.cyrillicPct + '% | Best: ' + stats.bestEncoding + '</span>' +
      '<div style="margin-left:auto;display:flex;gap:4px">' +
      '<button data-view="hex">Hex</button> ' +
      '<button data-view="raw">Raw</button> ' +
      '<button data-action="runScanAndNextReadable">Next readable</button> ' +
      '<button data-action="analyseChunk">Analyse</button> ' +
      '<button data-action="hideRejectedBanner">&#x2715;</button>' +
      '</div></div>';
    $('editor-body').appendChild(bar);
  }

  function hideRejectedBanner() {
    const b = $('rejected-banner');
    if (b) b.remove();
    $('text-area').style.paddingTop = '6px';
  }

  function renderStats(s) {
    const p = $('stats-panel');
    if (!s) {
      p.innerHTML = '<div class="stat-row"><span class="stat-label">No stats</span></div>';
      return;
    }
    const bars = [
      { label: 'Printable', val: s.printablePct, cls: pctClass(s.printablePct), color: '#4ec9b0' },
      { label: 'Cyrillic', val: s.cyrillicPct, cls: '', color: '#569cd6' },
      { label: 'Latin', val: s.latinPct, cls: '', color: '#dcdcaa' },
      { label: 'Replaced', val: s.replacedPct, cls: pctClass(100 - s.replacedPct), color: '#f44747' },
      { label: 'Control', val: s.controlPct, cls: pctClass(100 - s.controlPct), color: '#ce9178' },
      { label: 'Whitespace', val: s.whitespacePct, cls: '', color: '#969696' },
    ];
    let html = '';
    bars.forEach(b => {
      html += '<div class="stat-row">' +
        '<span class="stat-label">' + b.label + '</span>' +
        '<span class="stat-value ' + b.cls + '">' + b.val + '%</span></div>' +
        '<div class="stat-bar"><div class="stat-bar-fill" style="width:' + Math.min(100, b.val) + '%;background:' + b.color + '"></div></div>';
    });
    if (s.encodingProbe) {
      html += '<div style="margin-top:4px"><span class="stat-label">Encoding probe:</span></div>';
      s.encodingProbe.forEach(e => {
        html += '<div class="enc-probe">' + e.name + ': ' + (100 - e.badPct).toFixed(0) + '% clean</div>';
      });
      html += '<div class="enc-probe">Best: <b>' + s.bestEncoding + '</b></div>';
      if (state.decodedEncoding) {
        html += '<div class="enc-probe">Decoded as: <b style="color:var(--green)">' + state.decodedEncoding + '</b></div>';
      }
    }
    p.innerHTML = html;
  }

  function updateStatus(offset, lineCount, stats) {
    const approx = offset > 0 && !state.sequential;
    const lp = approx ? '~' : '';
    $('st-lines').textContent = lp + 'Ln ' + state.startLine;
    const pct = state.fileSize > 0 ? ((offset / state.fileSize) * 100).toFixed(1) : 0;
    $('st-offset').textContent = fmtNum(offset) + ' / ' + fmtNum(state.fileSize) + ' (' + pct + '%)';
    const endOff = Math.min(offset + CHUNK, state.fileSize);
    $('st-range').textContent = fmtNum(offset) + '-' + fmtNum(endOff);
    $('st-chars').textContent = fmtNum(lineCount) + ' lines';
    $('st-filter').textContent =
      state.viewMode === 'text' ? 'filtered' : state.viewMode === 'hex' ? 'hex' : 'raw';
    var sm = state.skipMode;
    $('st-skipmode').textContent = sm !== 'off' ? 'skip: ' + sm : '';
    const readableEl = $('st-readable');
    if (stats) {
      if (stats.isReadable) {
        readableEl.textContent = 'OK';
        readableEl.style.color = '#4ec9b0';
      } else {
        readableEl.textContent = 'REJECTED';
        readableEl.style.color = '#f44747';
      }
    } else {
      readableEl.textContent = '';
    }
    updateSlider();
    $('st-encoding').textContent = state.decodedEncoding || 'UTF-8';
  }

  function highlightText(html, query) {
    if (!query) return html;
     var esc = query.replace(new RegExp('[' + String.fromCharCode(46,42,43,63,94,36,123,125,40,41,124,91,93,92) + ']', 'g'), function(m){ return '\\\\' + m; });
    var re = new RegExp('(' + esc + ')', 'gi');
    return html.replace(re, '<span class="hl-match">$1</span>');
  }

  function highlightHtml(html, query) {
    if (!query) return html;
    var doc = new DOMParser().parseFromString(html, 'text/html');
     var esc = query.replace(new RegExp('[' + String.fromCharCode(46,42,43,63,94,36,123,125,40,41,124,91,93,92) + ']', 'g'), function(m){ return '\\\\' + m; });
    var re = new RegExp(esc, 'gi');
    var walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    var textNodes = [];
    var n;
    while ((n = walker.nextNode())) {
      var pn = n.parentElement;
      if (pn && !pn.closest('script,style,textarea,.hl-match')) textNodes.push(n);
    }
    for (var i = 0; i < textNodes.length; i++) {
      var tn = textNodes[i];
      var txt = tn.nodeValue || '';
      if (!re.test(txt)) { re.lastIndex = 0; continue; }
      re.lastIndex = 0;
      var frag = doc.createDocumentFragment();
      var lastIdx = 0;
      var m;
      while ((m = re.exec(txt))) {
        frag.append(txt.slice(lastIdx, m.index));
        var sp = doc.createElement('span');
        sp.className = 'hl-match';
        sp.textContent = m[0];
        frag.append(sp);
        lastIdx = m.index + m[0].length;
      }
      frag.append(txt.slice(lastIdx));
      tn.replaceWith(frag);
    }
    return doc.body.innerHTML;
  }

  function jumpToOffset() {
    const off = parseInt($('jump-offset').value);
    if (!isNaN(off) && off >= 0) {
      state.sequential = false;
      loadChunk(off);
    }
  }
  try { $('jump-offset').onkeydown = e => { if (e.key === 'Enter') jumpToOffset(); }; } catch(e) { console.error('[webview] jump-offset init error', e); }

  async function nextPage() {
    send({ cmd: 'nextPage' });
  }

  async function prevPage() {
    send({ cmd: 'prevPage' });
  }

  function goTop() { send({ cmd: 'goTop' }); }
  function goBottom() { send({ cmd: 'goBottom' }); }

  function jumpToNext(mode) {
    send({ cmd: mode === 'readable' ? 'jumpReadable' : 'jumpUnreadable' });
  }

  function runScanAndNextReadable() {
    jumpToNext('readable');
  }

  function setSkipMode(mode) {
    state.skipMode = mode;
    send({ cmd: 'setSkipMode', mode });
  }

  function showScanUI(show) {
    $('scan-progress-row').style.display = show ? 'flex' : 'none';
    $('scan-bar').style.display = show ? 'block' : 'none';
  }

  function abortScan() {
    send({ cmd: 'abortScan' });
  }

  // Auto-repeat on hold for Prev/Next buttons — fire at max rate
  try {
    (function(){
      var _repeatTimer = null;
      var _repeatBtns = document.querySelectorAll('[data-action="prevPage"],[data-action="nextPage"]');
      _repeatBtns.forEach(function(btn){
        var action = btn.getAttribute('data-action');
        btn.addEventListener('mousedown', function(ev){
          ev.preventDefault();
          if (window[action]) window[action]();
          _repeatTimer = setInterval(function(){
            if (window[action]) window[action]();
          }, 0);
        });
        var stop = function(){ clearInterval(_repeatTimer); _repeatTimer = null; };
        btn.addEventListener('mouseup', stop);
        btn.addEventListener('mouseleave', stop);
      });
    })();
  } catch(e) { console.error('[webview] auto-repeat init error', e); }

  // Analyse
  function analyseChunk() {
    send({ cmd: 'analyse', offset: state.currentOffset });
  }

  function renderAnalyse(d) {
    const p = $('analyse-panel');
    p.className = 'show';
    const s = d.stats;
     let html = '<span class="close-btn" data-action="closeAnalyse">&times;</span>';
    html += '<h2>Chunk Analysis — offset ' + fmtNum(d.offset) + ' (' + fmtSize(d.offset) + ') [' + d.bytesRead + ' bytes]</h2>';

    html += '<div class="anal-section"><h3>Filter Pipeline</h3>';
    html += '<div class="info-text">' + d.filterApplied + '</div>';
    html += '<div style="margin-top:4px"><strong>Filtered preview (first 500 chars):</strong></div>';
    html += '<pre>' + escapeHtml(d.filteredPreview) + '</pre>';
    html += '</div>';

    html += '<div class="anal-section"><h3>Byte Class Distribution</h3><table>';
    html += '<tr><th>Class</th><th>Count</th><th>%</th></tr>';
    const bc = d.byteClasses;
    const total = d.bytesRead;
    const rows = [
      ['Null (0x00)', bc.null],
      ['Control 0x01-0x1F', bc.control_01_1f],
      ['DEL (0x7F)', bc.del],
      ['ASCII printable', bc.ascii_print],
      ['C1 controls 0x80-0x9F', bc.c1_controls],
      ['UTF-8 continuation', bc.utf8_cont],
      ['UTF-8 2-byte start', bc.utf8_start2],
      ['UTF-8 3-byte start', bc.utf8_start3],
      ['UTF-8 4-byte start', bc.utf8_start4],
      ['BOM/overlong (0xFE/FF)', bc.overlong_bom],
    ];
    rows.forEach(function(r) {
      const pct = total > 0 ? ((r[1]/total)*100).toFixed(1) : '0.0';
      const cls = r[1] > 0 && r[0].includes('Control') ? 'warn-row' : '';
      html += '<tr class="' + cls + '"><td>' + r[0] + '</td><td>' + fmtNum(r[1]) + '</td><td>' + pct + '%</td></tr>';
    });
    html += '</table></div>';

    html += '<div class="anal-section"><h3>Bad Byte Ranges (invalid UTF-8 sequences)</h3>';
    html += '<div class="info-text">Found ' + d.badRangesTotal + ' bad ranges. Showing first ' + d.badRanges.length + '.</div>';
    if (d.badRanges.length === 0) {
      html += '<div class="info-text" style="color:var(--green)">No bad UTF-8 sequences — file is valid UTF-8 here.</div>';
    } else {
      html += '<table><tr><th>File Offset</th><th>Length</th><th>Hex Preview</th><th>Decoded</th></tr>';
      d.badRanges.forEach(function(rng) {
        var dec = rng.decoded || {};
        let decStr = '';
        for (var enc in dec) decStr += enc + ': ' + escapeHtml(dec[enc].substring(0, 30)) + ' ';
        html += '<tr class="warn-row">';
        html += '<td>' + fmtNum(rng.fileOffset) + '</td>';
        html += '<td>' + rng.length + '</td>';
        html += '<td class="hex-col">' + escapeHtml(rng.hex) + '</td>';
        html += '<td class="dec-col">' + decStr + '</td>';
        html += '</tr>';
      });
      html += '</table>';
    }
    html += '</div>';

    html += '<div class="anal-section"><h3>Summary</h3>';
    if (s) {
      const readable = s.isReadable;
      html += '<span class="badge ' + (readable ? 'green' : 'red') + '">' + (readable ? 'READABLE' : 'REJECTED') + '</span> ';
      html += '<span class="badge ' + (s.replacedPct > 10 ? 'red' : 'green') + '">U+FFFD ' + s.replacedPct + '%</span> ';
      html += '<span class="badge yellow">Cyrillic ' + s.cyrillicPct + '%</span> ';
      html += '<span class="badge ' + (s.printablePct > 50 ? 'green' : 'yellow') + '">Printable ' + s.printablePct + '%</span>';
      html += '<div class="info-text" style="margin-top:4px">Best encoding guess: <strong>' + s.bestEncoding + '</strong></div>';
    }
    html += '</div>';

    p.innerHTML = html;
  }

  function closeAnalyse() {
    $('analyse-panel').className = '';
  }

  // Search
  async function doSearch() {
    const q = $('search-q').value.trim();
    if (!q) return;
    state.searchQuery = q;
    const sr = $('search-results');
    sr.innerHTML = '<div class="match-item">Searching whole file...</div>';
    send({ cmd: 'search', query: q, from: state.currentOffset, wholeFile: true });
  }
  try { $('search-q').onkeydown = e => { if (e.key === 'Enter') doSearch(); }; } catch(e) { console.error('[webview] search init error', e); }

  function goToMatch(offset) {
    state.sequential = false;
    state.currentOffset = offset;
    loadChunk(offset);
  }

  // Keyboard shortcuts
  try {
    document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeAnalyse(); closeSlider(); }
    if (e.ctrlKey && e.key === 'f') { e.preventDefault(); $('search-q').focus(); }
    if (e.ctrlKey && e.key === 'l') { e.preventDefault(); $('jump-offset').focus(); }
    if (e.altKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); send({ cmd: 'toggleWrap' }); }
    if (e.key === 'F5' && !e.ctrlKey) { e.preventDefault(); loadChunk(state.currentOffset); }
    if (e.key === 'PageDown' && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); nextPage(); }
    if (e.key === 'PageUp' && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); prevPage(); }
    });
  } catch(e) { console.error('[webview] keyboard init error', e); }

  // Message handler
  try {
    window.addEventListener("message", e => {
    const msg = e.data;
    switch (msg.cmd) {
      case "chunk": {
        state.currentOffset = msg.offset;
        state.fileSize = msg.fileSize || state.fileSize;
        state.stats = msg.stats || null;
        state.decodedEncoding = msg.decodedEncoding || null;
        state.startLine = msg.startLine || 1;
        renderStats(msg.stats);

        hideRejectedBanner();

        // Compute line count
        const lines = msg.lines || [];
        const lineCount = lines.length;

        if (state.viewMode === 'hex' || state.viewMode === 'raw') {
          // hex/raw handled by hex/raw message
          updateStatus(msg.offset, lineCount, msg.stats);
          showLoading(false);
          break;
        }

        const gutter = $('gutter');
        const textArea = $('text-area');
        const hexView = $('hex-view');
        const rawView = $('raw-view');

        gutter.style.display = 'block';
        textArea.style.display = 'block';
        hexView.style.display = 'none';
        rawView.style.display = 'none';

        // Render lines with gutter
        let gtext = '', thtml = '';
        const sl = msg.startLine || 1;
        for (let i = 0; i < lines.length; i++) {
          gtext += (sl + i) + '\n';
          let t = lines[i];
          if (state.searchQuery) {
            t = highlightText(t, state.searchQuery);
          }
          thtml += t + '\n';
        }
        gutter.textContent = gtext;
        textArea.innerHTML = thtml;

        updateStatus(msg.offset, lineCount, msg.stats);

        // Rejected banner
        if (msg.rejected && msg.stats) {
          showRejectedBanner(msg.stats);
        }

        // Update jump inputs
        $('jump-offset').value = msg.offset;

        showLoading(false);
        break;
      }
      case "hex": {
        const hv = $('hex-view');
        const rv = $('raw-view');
        const ta = $('text-area');
        const gt = $('gutter');
        ta.style.display = 'none';
        gt.style.display = 'none';
        rv.style.display = 'none';
        hv.style.display = 'block';
        hv.textContent = msg.data;
        updateSlider();
        showLoading(false);
        break;
      }
      case "raw": {
        const hv = $('hex-view');
        const rv = $('raw-view');
        const ta = $('text-area');
        const gt = $('gutter');
        ta.style.display = 'none';
        gt.style.display = 'none';
        hv.style.display = 'none';
        rv.style.display = 'block';
        rv.textContent = msg.data;
        updateSlider();
        showLoading(false);
        break;
      }
      case "searchResult": {
        state.searchMatches = msg.matches || [];
        const sr = $('search-results');
        if (!state.searchMatches.length) {
          sr.innerHTML = '<div class="match-item" style="color:var(--orange)">No matches (scanned ' + fmtSize(msg.scanned || 0) + ')</div>';
          return;
        }
        let html = '<div style="padding:2px 6px;color:var(--fg2);font-size:9px">' +
          msg.matches.length + ' matches in ' + fmtSize(msg.scanned || 0) + '</div>';
         state.searchMatches.forEach((off, i) => {
          html += '<div class="match-item" data-offset="' + off + '">' +
            (i + 1) + ': ' + fmtNum(off) + '</div>';
        });
        sr.innerHTML = html;
        if (state.searchQuery) {
          // Re-render current view with highlights
          const textArea = $('text-area');
          const currentHtml = textArea.innerHTML;
           textArea.innerHTML = highlightHtml(currentHtml, state.searchQuery);
        }
        break;
      }
      case "analyse": {
        renderAnalyse(msg.data);
        showLoading(false);
        break;
      }
      case "analyseError": {
        closeAnalyse();
        showLoading(false);
        break;
      }
      case "closeAnalyse": {
        closeAnalyse();
        break;
      }
      case "fileInfo": {
        state.fileSize = msg.size || 0;
        state.fileName = msg.name;
        $('tab-name').textContent = msg.name;
        updateSlider();
        break;
      }
      case "theme": {
        const c = msg.colors || {};
        const root = document.documentElement;
        for (const [k, v] of Object.entries(c)) {
          root.style.setProperty('--' + k, v);
        }
        break;
      }
      case "viewMode": {
        state.viewMode = msg.mode;
        $('btn-text').className = msg.mode === 'text' ? 'primary' : '';
        $('btn-hex').className = msg.mode === 'hex' ? 'primary' : '';
        $('btn-raw').className = msg.mode === 'raw' ? 'primary' : '';
        $('tab-mode').textContent =
          msg.mode === 'text' ? '[filtered]' : msg.mode === 'hex' ? '[hex]' : '[raw]';
        break;
      }
      case "wrap": {
        const ta = $('text-area');
        ta.style.whiteSpace = msg.enabled ? 'pre-wrap' : 'pre';
        ta.style.wordBreak = msg.enabled ? 'break-all' : 'normal';
        break;
      }
      case "skipMode": {
        state.skipMode = msg.mode;
        $('skip-mode').value = msg.mode;
        $('st-skipmode').textContent = msg.mode !== 'off' ? 'skip: ' + msg.mode : '';
        break;
      }
      case "fontSize": {
        const size = msg.size;
        $('text-area').style.fontSize = size + 'px';
        $('gutter').style.fontSize = size + 'px';
        break;
      }
      case "scanProgress": {
        showScanUI(true);
        showLoading(true, 'Scanning...');
        $('scan-label').textContent = 'Scanning... ' + msg.progress + '%';
        $('scan-bar-fill').style.width = msg.progress + '%';
        break;
      }
      case "scanDone": {
        showScanUI(false);
        showLoading(false);
        break;
      }
      case "scanAborted": {
        state.scanCancelled = true;
        showScanUI(false);
        showLoading(false);
        break;
      }
      case "toggleSlider": {
        toggleSlider();
        break;
      }
      case "closeSlider": {
        closeSlider();
        break;
      }
    }
  });
  } catch(e) { console.error('[webview] message handler init error', e); }

  // Expose on window for inline onclick handlers
  window.prevPage = prevPage;
  window.nextPage = nextPage;
  window.goTop = goTop;
  window.goBottom = goBottom;
  window.jumpToNext = jumpToNext;
  window.jumpToOffset = jumpToOffset;
  window.setView = setView;
  window.doSearch = doSearch;
  window.goToMatch = goToMatch;
  window.analyseChunk = analyseChunk;
  window.closeAnalyse = closeAnalyse;
  window.toggleSlider = toggleSlider;
  window.runScanAndNextReadable = runScanAndNextReadable;
  window.abortScan = abortScan;
  window.hideRejectedBanner = hideRejectedBanner;
  window.setSkipMode = setSkipMode;

  vs.postMessage({ cmd: "theme" });
})();
} catch(e) { console.error('[webview] fatal init error', e); }
</script>
</body>
</html>`;
  }

  public dispose() {
    this.cancelScan();
    if (this.fd !== null) {
      try { fsNode.closeSync(this.fd); } catch {
        // Recovery: fd already closed or invalid during disposal — safe to ignore
      }
      this.fd = null;
    }
    this.panel.dispose();
    while (this.disposeHandlers.length) {
      this.disposeHandlers.pop()?.dispose();
    }
    if (ExaPagerPanel.currentPanel === this) {
      ExaPagerPanel.currentPanel = undefined;
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("exapager.open", () => {
      vscode.window.showOpenDialog({
        openLabel: "Open with ExaPager",
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          Text: ["txt", "text", "log", "csv", "tsv", "json", "xml", "html", "md", "rst"],
          All: ["*"],
        },
      }).then((uris) => {
        if (!uris || uris.length === 0) return;
        ExaPagerPanel.render(context.extensionUri, uris[0].fsPath);
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("exapager.openActive", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc && doc.uri.scheme === "file") {
        ExaPagerPanel.render(context.extensionUri, doc.uri.fsPath);
      } else {
        vscode.window.showErrorMessage("No active file to preview.");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("exapager.previewFile", (uri: vscode.Uri) => {
      if (uri && uri.scheme === "file") {
        ExaPagerPanel.render(context.extensionUri, uri.fsPath);
      } else {
        const doc = vscode.window.activeTextEditor?.document;
        if (doc && doc.uri.scheme === "file") {
          ExaPagerPanel.render(context.extensionUri, doc.uri.fsPath);
        } else {
          vscode.window.showErrorMessage("No file to preview.");
        }
      }
    })
  );
}

export function deactivate(): void {
  ExaPagerPanel.currentPanel?.dispose();
}
