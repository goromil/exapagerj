export const CHUNK_SIZE = 262144;
export const HEX_DUMP_SIZE = 16384;
export const SEARCH_WINDOW = 5 * 1024 * 1024;
export const SCAN_STEP = 1024 * 1024;

const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const WHITESPACE_RE = /[ \t]+/g;

const PROBLEM_RE = /[\ufffd\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " ", "&#39;": "'", "&#34;": '"',
};
const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|apos|nbsp|#39|#34);/g;

export function filterText(text: string): string {
  return text.replace(PROBLEM_RE, " ").replace(WHITESPACE_RE, " ").replace(HTML_ENTITY_RE, (m) => HTML_ENTITIES[m] || m);
}

export interface ChunkStats {
  totalBytes: number; replaced: number; replacedPct: number; control: number; controlPct: number;
  cyrillic: number; cyrillicPct: number; latin: number; latinPct: number;
  printable: number; printablePct: number; whitespace: number; whitespacePct: number;
  problemChars: number; problemPct: number; isReadable: boolean; bestEncoding: string;
  encodingProbe: { name: string; badPct: number; badChars: number }[];
  scripts: Record<string, number>;
}

function isPrintable(c: string): boolean {
  const code = c.charCodeAt(0);
  return (code >= 0x20 && code < 0xd800) || (code >= 0xe000 && code < 0xfffe);
}
function round(n: number): number { return Math.round(n * 10) / 10; }

export function chunkStats(rawBytes: Buffer, text: string): ChunkStats | null {
  const total = rawBytes.length;
  if (!total) return null;
  const replaced = (text.match(/\ufffd/g) || []).length;
  const controlChars = "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f\x7f";
  const control = [...text].filter(c => controlChars.includes(c)).length;
  const scripts = detectScripts(text);
  const cyrillic = scripts['Cyrillic'] || 0;
  const latin = scripts['Latin'] || 0;
  const printable = [...text].filter(c => c !== "\ufffd" && c !== "" && isPrintable(c)).length;
  const whitespace = [...text].filter(c => " \t\n\r".includes(c)).length;
  const problemChars = replaced + control;
  const probe = probeEncoding(rawBytes);
  const bestEnc = probe.length > 0 && probe[0].badPct < 30 ? probe[0].name : "utf-8";
  return {
    totalBytes: total, replaced, replacedPct: round(replaced / total * 100),
    control, controlPct: round(control / total * 100),
    cyrillic, cyrillicPct: round(cyrillic / total * 100),
    latin, latinPct: round(latin / total * 100),
    printable, printablePct: round(printable / total * 100),
    whitespace, whitespacePct: round(whitespace / total * 100),
    problemChars, problemPct: round(problemChars / total * 100),
    isReadable: (problemChars / total) < 0.5 && (printable / total) * 100 > 5,
    bestEncoding: bestEnc, encodingProbe: probe.slice(0, 4), scripts,
  };
}

export function detectScripts(text: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of text) {
    const code = c.charCodeAt(0);
    let script: string | undefined;
    if ((code >= 0x0041 && code <= 0x005A) || (code >= 0x0061 && code <= 0x007A) || (code >= 0x00C0 && code <= 0x024F) || (code >= 0x1E00 && code <= 0x1EFF)) script = "Latin";
    else if (code >= 0x0400 && code <= 0x04FF || (code >= 0x0500 && code <= 0x052F)) script = "Cyrillic";
    else if ((code >= 0x0370 && code <= 0x03FF) || (code >= 0x1F00 && code <= 0x1FFF)) script = "Greek";
    else if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) script = "CJK";
    else if ((code >= 0xAC00 && code <= 0xD7AF) || (code >= 0x1100 && code <= 0x11FF)) script = "Hangul";
    else if ((code >= 0x3040 && code <= 0x309F) || (code >= 0x30A0 && code <= 0x30FF)) script = "Kana";
    else if ((code >= 0x0600 && code <= 0x06FF) || (code >= 0x0750 && code <= 0x077F)) script = "Arabic";
    else if (code >= 0x0590 && code <= 0x05FF) script = "Hebrew";
    else if (code >= 0x0530 && code <= 0x058F) script = "Armenian";
    else if ((code >= 0x10A0 && code <= 0x10FF) || (code >= 0x2D00 && code <= 0x2D2F)) script = "Georgian";
    else if (code >= 0x0900 && code <= 0x097F) script = "Devanagari";
    else if (code >= 0x0E00 && code <= 0x0E7F) script = "Thai";
    else if ((code >= 0x2200 && code <= 0x22FF) || (code >= 0x2A00 && code <= 0x2AFF)) script = "Math";
    else if ((code >= 0x2000 && code <= 0x206F) || (code >= 0x2E00 && code <= 0x2E7F)) script = "Punctuation";
    if (script) counts[script] = (counts[script] || 0) + 1;
  }
  return counts;
}

export function probeEncoding(raw: Buffer): { name: string; badPct: number; badChars: number }[] {
  const results: { name: string; badPct: number; badChars: number }[] = [];
  const total = raw.length;

  // BOM detection — authoritative when present
  if (total >= 3) {
    if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
      results.push({ name: "utf-8", badPct: 0, badChars: 0 });
      return results; // definitive
    }
    if (raw[0] === 0xFF && raw[1] === 0xFE) {
      results.push({ name: "utf-16le", badPct: 0, badChars: 0 });
      return results;
    }
    if (raw[0] === 0xFE && raw[1] === 0xFF) {
      results.push({ name: "utf-16be", badPct: 0, badChars: 0 });
      return results;
    }
  }

  // Core encodings via Node Buffer (always available)
  const utf8Text = raw.toString("utf-8");
  const utf8Bad = (utf8Text.match(/\ufffd/g) || []).length;
  results.push({ name: "utf-8", badPct: round(utf8Bad / total * 100), badChars: utf8Bad });
  results.push({ name: "ascii", badPct: round(raw.filter(b => b > 127).length / total * 100), badChars: raw.filter(b => b > 127).length });
  results.push({ name: "latin1", badPct: 0, badChars: 0 }); // latin1 never fails

  // Extended encodings via iconv-lite
  const encToProbe = [
    { name: "windows-1251", hint: "Cyrillic" },
    { name: "koi8-r", hint: "Russian KOI8-R" },
    { name: "windows-1252", hint: "Western European" },
    { name: "windows-1250", hint: "Polish/Czech/Croatian" },
    { name: "windows-1253", hint: "Armenian/Greek" },
    { name: "windows-1254", hint: "Turkish" },
    { name: "windows-1255", hint: "Hebrew" },
    { name: "iso-8859-8", hint: "Hebrew ISO" },
    { name: "windows-1257", hint: "Baltic" },
    { name: "gb18030", hint: "Simplified CJK" },
    { name: "gbk", hint: "GBK" },
    { name: "shift_jis", hint: "Japanese" },
    { name: "euc-kr", hint: "Korean" },
    { name: "big5", hint: "Traditional CJK" },
    { name: "iso-8859-5", hint: "Cyrillic ISO" },
    { name: "iso-8859-7", hint: "Greek" },
    { name: "georgian-academy", hint: "Georgian" },
    { name: "maccyrillic", hint: "Mac Cyrillic" },
  ];

  try {
    const iconv = require("iconv-lite");
    for (const enc of encToProbe) {
      try {
        const decoded = iconv.decode(raw, enc.name);
        const bad = [...decoded].filter((c: string) => c === "\ufffd" || (!isPrintable(c) && !" \t\n\r".includes(c))).length;
        results.push({ name: enc.name, badPct: round(bad / total * 100), badChars: bad });
      } catch {
        results.push({ name: enc.name, badPct: 100, badChars: total });
      }
    }
  } catch {
    // iconv-lite not available — skip extended probing
  }

  // Byte-level heuristics to boost likely candidates
  const highBytes = raw.filter(b => b >= 0x80).length;
  const cjkRange = raw.filter(b => b >= 0x81 && b <= 0xFE).length;

  // If high bytes are abundant and UTF-8 has errors, boost CJK/CP1251
  if (highBytes > total * 0.1 && utf8Bad > total * 0.05) {
    for (const r of results) {
      if (r.name === "utf-8" && r.badPct > 5) r.badPct += 5; // penalize broken utf-8
      if (cjkRange > highBytes * 0.5) {
        if (["gb18030", "gbk", "big5", "shift_jis", "euc-kr"].includes(r.name)) r.badPct = Math.max(0, r.badPct - 3);
      }
      if (r.name === "windows-1251") {
        // Check for typical Cyrillic byte range 0xC0-0xFF
        const cyrillicBytes = raw.filter(b => b >= 0xC0 && b <= 0xFF).length;
        if (cyrillicBytes > highBytes * 0.3) r.badPct = Math.max(0, r.badPct - 5);
      }
      if (r.name === "koi8-r") {
        // KOI8-R: letters in 0xA0-0xFF, frequent 0xE0+ bytes
        const koi8Bytes = raw.filter(b => b >= 0xA0 && b <= 0xFF).length;
        if (koi8Bytes > highBytes * 0.4) r.badPct = Math.max(0, r.badPct - 5);
      }
      if (["windows-1255", "iso-8859-8"].includes(r.name)) {
        // Hebrew: 0xE0-0xFF range for characters
        const hebBytes = raw.filter(b => b >= 0xE0 && b <= 0xFF).length;
        if (hebBytes > highBytes * 0.3 && hebBytes > total * 0.05) r.badPct = Math.max(0, r.badPct - 3);
      }
      if (r.name === "georgian-academy") {
        // Georgian Academy: 0xE0-0xEF
        const geoBytes = raw.filter(b => b >= 0xE0 && b <= 0xEF).length;
        if (geoBytes > highBytes * 0.5) r.badPct = Math.max(0, r.badPct - 3);
      }
    }
  }

  results.sort((a, b) => a.badPct - b.badPct);
  return results;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatOffset(n: number): string {
  if (n >= 1024**4) return (n / 1024**4).toFixed(2) + " TiB";
  if (n >= 1024**3) return (n / 1024**3).toFixed(2) + " GiB";
  if (n >= 1024**2) return (n / 1024**2).toFixed(2) + " MiB";
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
    const hexPart = Array.from(chunk).map(b => b.toString(16).padStart(2, "0")).join(" ");
    const hexPadded = hexPart.padEnd(47);
    const asciiPart = Array.from(chunk).map(b => (b >= 32 ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${addr.toString(16).padStart(8, "0")}  ${hexPadded} |${asciiPart}|`);
  }
  return lines;
}

export interface BadRange {
  relOffset: number; fileOffset: number; length: number; hex: string;
  decoded: Record<string, string>;
}
export interface ByteClasses {
  null: number; control_01_1f: number; del: number; ascii_print: number;
  c1_controls: number; utf8_cont: number; utf8_start2: number; utf8_start3: number;
  utf8_start4: number; overlong_bom: number;
}
export interface AnalyseResult {
  offset: number; bytesRead: number; stats: ChunkStats | null; badRanges: BadRange[];
  badRangesTotal: number; byteClasses: ByteClasses; rawFirst200: string;
  filteredPreview: string; filterApplied: string;
}

export function analyseChunk(raw: Buffer, fileOffset: number): AnalyseResult {
  const text = raw.toString("utf-8");
  const filtered = filterText(text);
  const badRanges = findBadRanges(raw, fileOffset);
  const byteClasses = computeByteClasses(raw);
  const stats = chunkStats(raw, text);
  return {
    offset: fileOffset, bytesRead: raw.length, stats,
    badRanges: badRanges.slice(0, 100), badRangesTotal: badRanges.length,
    byteClasses, rawFirst200: Array.from(raw.slice(0, 200)).map(b => b.toString(16).padStart(2, "0")).join(" "),
    filteredPreview: filtered.slice(0, 500),
    filterApplied: "control chars stripped, whitespace collapsed, HTML unescaped",
  };
}

export function findBadRanges(raw: Buffer, fileOffset: number): BadRange[] {
  const ranges: BadRange[] = [];
  let i = 0, inBad = false, badStart = 0;
  while (i < raw.length) {
    const b = raw[i];
    let isBad = false;
    if (b === 0xff || b === 0xfe) isBad = true;
    else if (b >= 0x80) {
      try { raw.slice(i, i + 4).toString("utf-8"); } catch { isBad = true; }
    }
    if (isBad) { if (!inBad) { badStart = i; inBad = true; } }
    else if (inBad) {
      ranges.push(...buildBadRange(raw, badStart, i, fileOffset));
      inBad = false;
    }
    i++;
  }
  if (inBad) ranges.push(...buildBadRange(raw, badStart, i, fileOffset));
  return ranges;
}

function buildBadRange(raw: Buffer, start: number, end: number, fileOffset: number): BadRange[] {
  const length = end - start;
  const segment = raw.slice(start, end);
  const hexPreview = Array.from(segment.slice(0, 32)).map(b => b.toString(16).padStart(2, "0")).join(" ");
  const hex = length > 32 ? `${hexPreview} ... (${length} bytes)` : hexPreview;
  const decoded: Record<string, string> = {};
  for (const enc of ["utf-8", "ascii", "latin1"] as const) {
    try { decoded[enc] = segment.toString(enc).slice(0, 60); } catch { decoded[enc] = "<decode error>"; }
  }
  return [{ relOffset: start, fileOffset: fileOffset + start, length, hex, decoded }];
}

export function computeByteClasses(raw: Buffer): ByteClasses {
  let n = 0, c01 = 0, d = 0, ap = 0, c1 = 0, uc = 0, s2 = 0, s3 = 0, s4 = 0, ob = 0;
  for (let i = 0; i < raw.length; i++) {
    const b = raw[i];
    if (b === 0) n++;
    else if (b >= 0x01 && b <= 0x1f && b !== 0x0a && b !== 0x0d && b !== 0x09) c01++;
    else if (b === 0x7f) d++;
    else if (b >= 0x20 && b <= 0x7e) ap++;
    else if (b >= 0x80 && b <= 0x9f) c1++;
    else if (b >= 0x80 && b <= 0xbf) uc++;
    else if (b >= 0xc0 && b <= 0xdf) s2++;
    else if (b >= 0xe0 && b <= 0xef) s3++;
    else if (b >= 0xf0 && b <= 0xf7) s4++;
    else if (b === 0xfe || b === 0xff) ob++;
  }
  return { null: n, control_01_1f: c01, del: d, ascii_print: ap, c1_controls: c1, utf8_cont: uc, utf8_start2: s2, utf8_start3: s3, utf8_start4: s4, overlong_bom: ob };
}

export function isReadableChunk(text: string): boolean {
  if (!text.length) return false;
  const cleaned = text.replace(PROBLEM_RE, "");
  const goodRatio = cleaned.length / text.length;
  const printable = [...text].filter(c => c !== "\ufffd" && isPrintable(c)).length;
  return goodRatio > 0.5 && (printable / text.length) * 100 > 5;
}
