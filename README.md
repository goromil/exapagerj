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

## Architecture

```
VS Code Extension (TypeScript)
  └── fs.read() with file descriptor ──> chunked reads (64 KiB)
  └── embedded VS Code webview iframe
        └── inline HTML/CSS/JS UI
```

The extension opens a raw file descriptor and reads chunks on demand. No subprocess, no HTTP server, no port management.

## Features

- **Chunked reading** — 64 KiB text / 16 KiB hex chunks, regardless of file size
- **Encoding detection** — auto-detects UTF-8, UTF-8 BOM, UTF-16 BE/LE
- **Hex dump** — side-by-side hex + ASCII view
- **Search** — case-insensitive search within 5 MiB window, up to 200 matches
- **Navigation** — seek to offset, slider, start/prev/next/end
- **Theme-aware** — adapts to VS Code dark/light/high-contrast themes
- **Readability stats** — shows % of readable characters per chunk

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
# exapagerj
# exapagerj
