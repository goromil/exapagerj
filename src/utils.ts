export const CHUNK_SIZE = 65536;
export const HEX_DUMP_SIZE = 16384;
export const SEARCH_WINDOW = 5 * 1024 * 1024;
export const SKIP_STEP = 64 * 1024;
export const SCAN_STEP = 1024 * 1024;

type BufferEncoding = "ascii" | "latin1" | "utf-8";
type Buffer = Uint8Array & {
  toString(encoding?: BufferEncoding): string;
  slice(start?: number, end?: number): Buffer;
};

// Regex patterns
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const WHITESPACE_RE = /[ \t]+/g;
const CYRILLIC_RE = /[\u0400-\u04FF]/g;
const LATIN_RE = /[A-Za-z\u00C0-\u024F]/g;
const PROBLEM_RE = /[\ufffd\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// HTML entity map for unescape
const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
  "&#39;": "'",
  "&#34;": '"',
};
const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|nbsp|#39|#34);/g;

export function filterText(text: string): string {
  return text
    .replace(PROBLEM_RE, " ")
    .replace(WHITESPACE_RE, " ")
    .replace(HTML_ENTITY_RE, (m) => HTML_ENTITIES[m] || m);
}

export interface ChunkStats {
  totalBytes: number;
  replaced: number;
  replacedPct: number;
  control: number;
  controlPct: number;
  cyrillic: number;
  cyrillicPct: number;
  latin: number;
  latinPct: number;
  printable: number;
  printablePct: number;
  whitespace: number;
  whitespacePct: number;
  problemChars: number;
  problemPct: number;
  isReadable: boolean;
  bestEncoding: string;
  encodingProbe: EncodingProbeResult[];
}

export function chunkStats(rawBytes: Buffer, text: string): ChunkStats | null {
  const total = rawBytes.length;
  if (!total) return null;

  const replaced = text.split("").filter((c) => c === "\ufffd").length;
  const control = text.split("").filter((c) => "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f\x7f".includes(c)).length;
  const cyrillic = (text.match(CYRILLIC_RE) || []).length;
  const latin = (text.match(LATIN_RE) || []).length;
  const printable = text.split("").filter((c) => c !== "\ufffd" && c !== "" && isPrintable(c)).length;
  const whitespace = text.split("").filter((c) => " \t\n\r".includes(c)).length;
  const problemChars = replaced + control;

  const probe = probeEncoding(rawBytes);
  const bestEnc = probe.length > 0 && probe[0].badPct < 30 ? probe[0].name : "utf-8";

  return {
    totalBytes: total,
    replaced,
    replacedPct: round(replaced / total * 100),
    control,
    controlPct: round(control / total * 100),
    cyrillic,
    cyrillicPct: round(cyrillic / total * 100),
    latin,
    latinPct: round(latin / total * 100),
    printable,
    printablePct: round(printable / total * 100),
    whitespace,
    whitespacePct: round(whitespace / total * 100),
    problemChars,
    problemPct: round(problemChars / total * 100),
    isReadable: (problemChars / total) < 0.5 && (printable / total) * 100 > 5,
    bestEncoding: bestEnc,
    encodingProbe: probe.slice(0, 4),
  };
}

function isPrintable(c: string): boolean {
  const code = c.charCodeAt(0);
  return code >= 0x20 && code < 0xd800 || (code >= 0xe000 && code < 0xfffe);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface EncodingProbeResult {
  name: string;
  badPct: number;
  badChars: number;
}

export function probeEncoding(raw: Buffer): EncodingProbeResult[] {
  // Node.js only supports a limited set of encodings natively.
  // For extended encoding support, use iconv-lite.
  const encodings: BufferEncoding[] = ["ascii", "latin1"];
  const results: EncodingProbeResult[] = [];
  const total = raw.length;

  // Also check utf-8 as baseline
  const utf8Text = raw.toString("utf-8");
  const utf8Bad = utf8Text.split("").filter((c) => c === "\ufffd").length;
  results.push({ name: "utf-8", badPct: round(utf8Bad / total * 100), badChars: utf8Bad });

  for (const encName of encodings) {
    try {
      const decoded = raw.toString(encName);
      const badChars = decoded.split("").filter((c) => !isPrintable(c) && !" \t\n\r".includes(c)).length;
      results.push({ name: encName, badPct: round(badChars / total * 100), badChars });
    } catch (err) {
      console.error(`[ExaPager] probeEncoding: unsupported encoding "${encName}":`, err);
      results.push({ name: encName, badPct: 100, badChars: total });
    }
  }

  results.sort((a, b) => a.badPct - b.badPct);
  return results;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatOffset(n: number): string {
  if (n >= 1024 * 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024 * 1024)).toFixed(2) + " TiB";
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(2) + " GiB";
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + " MiB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KiB";
  return n + " B";
}

export function formatSize(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}

export function byteToHex(b: number): string {
  return b.toString(16).padStart(2, "0");
}

export function hexRow(data: Buffer, rowOffset: number): string {
  const hexParts: string[] = [];
  const asciiParts: string[] = [];
  for (let i = 0; i < 16; i++) {
    const idx = rowOffset + i;
    if (idx < data.length) {
      hexParts.push(byteToHex(data[idx]));
      asciiParts.push(data[idx] >= 0x20 && data[idx] < 0x7f ? String.fromCharCode(data[idx]) : ".");
    } else {
      hexParts.push("  ");
      asciiParts.push(" ");
    }
  }
  return `${rowOffset.toString(16).padStart(8, "0")}  ${hexParts.join(" ")}  |${asciiParts.join("")}|`;
}

export function hexDump(raw: Buffer, baseOffset: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < Math.min(raw.length, HEX_DUMP_SIZE); i += 16) {
    const chunk = raw.slice(i, i + 16);
    const addr = baseOffset + i;
    const hexPart = Array.from(chunk).map((b) => byteToHex(b as number)).join(" ");
    const hexPadded = hexPart.padEnd(47);
    const asciiPart = Array.from(chunk).map((b) => (b >= 32 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${addr.toString(16).padStart(8, "0")}  ${hexPadded} |${asciiPart}|`);
  }
  return lines;
}

export interface BadRange {
  relOffset: number;
  fileOffset: number;
  length: number;
  hex: string;
  decoded: Record<string, string>;
}

export interface ByteClasses {
  null: number;
  control_01_1f: number;
  del: number;
  ascii_print: number;
  c1_controls: number;
  utf8_cont: number;
  utf8_start2: number;
  utf8_start3: number;
  utf8_start4: number;
  overlong_bom: number;
}

export interface AnalyseResult {
  offset: number;
  bytesRead: number;
  stats: ChunkStats | null;
  badRanges: BadRange[];
  badRangesTotal: number;
  byteClasses: ByteClasses;
  rawFirst200: string;
  filteredPreview: string;
  filterApplied: string;
}

export function analyseChunk(raw: Buffer, fileOffset: number): AnalyseResult {
  const text = raw.toString("utf-8");
  const filtered = filterText(text);

  // Find bad byte ranges
  const badRanges = findBadRanges(raw, fileOffset);

  // Byte class distribution
  const byteClasses = computeByteClasses(raw);

  // Stats
  const stats = chunkStats(raw, text);

  return {
    offset: fileOffset,
    bytesRead: raw.length,
    stats,
    badRanges: badRanges.slice(0, 100),
    badRangesTotal: badRanges.length,
    byteClasses,
    rawFirst200: Array.from(raw.slice(0, 200)).map((b) => byteToHex(b)).join(" "),
    filteredPreview: filtered.slice(0, 500),
    filterApplied: "control chars stripped, whitespace collapsed, HTML unescaped",
  };
}

export function findBadRanges(raw: Buffer, fileOffset: number): BadRange[] {
  const ranges: BadRange[] = [];
  let i = 0;
  let inBad = false;
  let badStart = 0;

  while (i < raw.length) {
    const b = raw[i];
    let isBad = false;
    if (b === 0xff || b === 0xfe) {
      isBad = true;
    } else if (b >= 0x80) {
      try {
        (raw.slice(i, i + 4) as Buffer).toString("utf-8");
      } catch {
        // Recovery: invalid UTF-8 sequence at byte i — mark as bad range
        isBad = true;
      }
    }

    if (isBad) {
      if (!inBad) {
        badStart = i;
        inBad = true;
      }
    } else {
      if (inBad) {
        const length = i - badStart;
        const segment = raw.slice(badStart, i);
        const hexPreview = Array.from(segment.slice(0, 32)).map((b) => byteToHex(b)).join(" ");
        const hex = length > 32 ? `${hexPreview} ... (${length} bytes)` : hexPreview;
        const decoded: Record<string, string> = {};
        for (const enc of ["utf-8", "ascii", "latin1"]) {
          try {
            decoded[enc] = (segment as Buffer).toString(enc as BufferEncoding).slice(0, 60);
          } catch (err) {
            // Recovery: encoding "${enc}" failed for bad range, skip it
            console.error(`[ExaPager] findBadRanges: "${enc}" decode failed at offset ${badStart}:`, err);
          }
        }
        ranges.push({ relOffset: badStart, fileOffset: fileOffset + badStart, length, hex, decoded });
        inBad = false;
      }
    }
    i++;
  }

  if (inBad) {
    const length = i - badStart;
    const segment = raw.slice(badStart, i);
    const hexPreview = Array.from(segment.slice(0, 32)).map((b) => byteToHex(b)).join(" ");
    const hex = length > 32 ? `${hexPreview} ... (${length} bytes)` : hexPreview;
    const decoded: Record<string, string> = {};
    for (const enc of ["utf-8", "ascii", "latin1"]) {
      try {
        decoded[enc] = (segment as Buffer).toString(enc as BufferEncoding).slice(0, 60);
      } catch (err) {
        // Recovery: encoding "${enc}" failed for trailing bad range
        console.error(`[ExaPager] findBadRanges: "${enc}" decode failed (trailing) at offset ${badStart}:`, err);
      }
    }
    ranges.push({ relOffset: badStart, fileOffset: fileOffset + badStart, length, hex, decoded });
  }

  return ranges;
}

export function computeByteClasses(raw: Buffer): ByteClasses {
  let nullCount = 0, control01_1f = 0, del = 0, asciiPrint = 0;
  let c1Controls = 0, utf8Cont = 0, utf8Start2 = 0, utf8Start3 = 0, utf8Start4 = 0, overlongBom = 0;

  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (b === 0) nullCount++;
    else if (b >= 0x01 && b <= 0x1f && b !== 0x0a && b !== 0x0d && b !== 0x09) control01_1f++;
    else if (b === 0x7f) del++;
    else if (b >= 0x20 && b <= 0x7e) asciiPrint++;
    else if (b >= 0x80 && b <= 0x9f) c1Controls++;
    else if (b >= 0x80 && b <= 0xbf) utf8Cont++;
    else if (b >= 0xc0 && b <= 0xdf) utf8Start2++;
    else if (b >= 0xe0 && b <= 0xef) utf8Start3++;
    else if (b >= 0xf0 && b <= 0xf7) utf8Start4++;
    else if (b === 0xfe || b === 0xff) overlongBom++;
  }

  return { null: nullCount, control_01_1f: control01_1f, del, ascii_print: asciiPrint, c1_controls: c1Controls, utf8_cont: utf8Cont, utf8_start2: utf8Start2, utf8_start3: utf8Start3, utf8_start4: utf8Start4, overlong_bom: overlongBom };
}

export function isReadableChunk(text: string): boolean {
  if (!text.length) return false;
  const cleaned = text.replace(PROBLEM_RE, "");
  const goodRatio = cleaned.length / text.length;
  const printable = text.split("").filter((c) => c !== "\ufffd" && isPrintable(c)).length;
  const printablePct = printable / text.length * 100;
  return goodRatio > 0.5 && printablePct > 5;
}
