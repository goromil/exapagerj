# ExaPager — Large File Viewer (Pure TypeScript)

View multi-GB text files inside VS Code with encoding auto-detection, hex dump, and filtering — **zero Python dependency**.

ExaPager reads files directly from the VS Code extension host using Node.js `fs` with memory-mapped chunked reads, bypassing the editor's built-in file size limits.

## Differences from exapagerpy

| Feature | exapagerpy (Python) | exapagerj (TypeScript) |
|---------|-------------------|----------------------|
| Preview server | External Python HTTP server | Inline, via VS Code webview |
| Dependencies | Python 3.x required | Pure Node.js, zero Python |
| File access | Python `os.popen` | Node.js `fs.read` with file descriptor |
| Port discovery | Parse `EXAPAGER_PORT` from stdout | N/A — no external process |
| Extension config | `exapager.pythonPath`, `exapager.previewScriptPath` | None needed |
| Chunk size | 64 KiB | 256 KiB |
| Encodings | UTF-8, BOM detection | 20+ encodings with iconv-lite |

## Prerequisites

- VS Code 1.74+
- Node.js 16+ (for building)

## Setup

1. **Compile**
   ```bash
   npm run compile
   ```

2. **Debug** — press `F5` to launch the extension in a new VS Code window.

## Usage

| Command | Palette Entry |
|---------|--------------|
| `exapager.open` | `ExaPager: Open Large File` — opens a file picker |
| `exapager.openActive` | `ExaPager: Open Active File` — previews the currently active editor tab |
| `exapager.previewFile` | Context menu: right-click any file → `ExaPager: Preview File` |

## Keyboard Shortcuts

When the ExaPager panel is active, the following VS Code keybindings are available. They appear in **File > Preferences > Keyboard Shortcuts** filtered by `@ext:gorom.exapager`.

| Shortcut | Action | Command |
|----------|--------|---------|
| `Ctrl+F` | Focus search input | `exapager.focusSearch` |
| `Ctrl+G` | Go to byte offset | `exapager.focusOffset` |
| `Alt+Z` | Toggle word wrap | `exapager.toggleWrap` |
| `F5` | Reload current chunk | `exapager.reloadChunk` |
| `PgDn` | Next page (256 KB) | `exapager.nextPage` |
| `PgUp` | Previous page (256 KB) | `exapager.prevPage` |
| `Esc` | Stop search/scan, close panels | `exapager.abortOperation` |
| `Ctrl+Shift+S` | Toggle position slider | `exapager.toggleSlider` |
| `Ctrl+Shift+A` | Analyse current chunk | `exapager.analyseChunk` |

All shortcuts can be customized in VS Code's **Keyboard Shortcuts** editor.

## Features

- **Chunked reading** — 256 KiB chunks, regardless of file size
- **Encoding auto-detection** — BOM detection + 20+ encoding probes (see below)
- **Script detection** — Latin, Cyrillic, Greek, CJK, Hangul, Kana, Arabic, Hebrew, Armenian, Georgian, Devanagari, Thai
- **Hex dump** — side-by-side hex + ASCII view
- **Raw view** — hex-encoded raw bytes with wrap support
- **Search** — whole-file search with progress indicator and abort
- **Navigation** — seek to offset, slider, start/prev/next/end
- **Auto-skip** — skip to readable/unreadable chunks
- **Readability stats** — printable %, encoding probe, script distribution per chunk
- **Encoding Issues panel** — malformed UTF-8 ranges with hex preview and multi-encoding decode
- **Theme-aware** — adapts to VS Code dark/light/high-contrast themes
- **VS Code keybindings** — native integration, customizable in Keybindings editor

## Supported Encodings

### BOM Detection (authoritative)
- UTF-8 (EF BB BF)
- UTF-16 LE (FF FE)
- UTF-16 BE (FE FF)

### Probed Encodings (via iconv-lite)
| Encoding | Region |
|----------|--------|
| `utf-8` | Universal |
| `ascii` | Universal |
| `latin1` | Universal (lossless) |
| `windows-1251` | Russian, Ukrainian, Belarusian |
| `koi8-r` | Russian (legacy) |
| `maccyrillic` | Russian (Mac) |
| `windows-1252` | Western European |
| `windows-1250` | Polish, Czech, Croatian, Slovak, Hungarian |
| `windows-1253` | Greek, Armenian |
| `windows-1254` | Turkish |
| `windows-1255` | Hebrew (Windows) |
| `iso-8859-8` | Hebrew (ISO) |
| `windows-1257` | Baltic (Estonian, Latvian, Lithuanian) |
| `georgian-academy` | Georgian |
| `iso-8859-5` | Cyrillic (ISO) |
| `iso-8859-7` | Greek |
| `gb18030` | Simplified Chinese |
| `gbk` | Simplified Chinese (legacy) |
| `big5` | Traditional Chinese |
| `shift_jis` | Japanese |
| `euc-kr` | Korean |

### Byte-Level Heuristics
When UTF-8 decoding shows errors and high bytes are abundant:
- Penalizes broken UTF-8 scores
- Boosts CJK candidates when 0x81-0xFE bytes dominate
- Boosts CP1251/KOI8-R when Cyrillic byte patterns (0xC0-FF / 0xA0-FF) detected
- Boosts Hebrew when 0xE0-FF range is frequent
- Boosts Georgian Academy when 0xE0-0xEF pattern matches

## Architecture

```
VS Code Extension (TypeScript)
  ├── iconv-lite — 20+ encoding decode
  ├── fs.read() with file descriptor ──> chunked reads (256 KiB)
  └── embedded VS Code webview iframe
        └── static HTML/CSS/JS UI
```

The extension opens a raw file descriptor and reads chunks on demand. No subprocess, no HTTP server, no port management.

## Development

```bash
npm run compile      # one-time build
npm run watch        # watch mode
npm test             # run tests
npm run coverage     # run tests with coverage report
```

Open `.vscode/launch.json` and press F5 to debug the extension host.

## License

MIT
