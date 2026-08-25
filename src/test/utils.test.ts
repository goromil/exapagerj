import * as assert from "assert";
import {
  filterText, chunkStats, escapeHtml, formatOffset, formatSize,
  byteToHex, hexRow, hexDump, probeEncoding, analyseChunk,
  findBadRanges, computeByteClasses, isReadableChunk
} from "../utils";

suite("Utils Tests", () => {
  suite("filterText", () => {
    test("replaces control characters with spaces then collapses", () => {
      const result = filterText("hello\x00world\x01test");
      assert.strictEqual(result, "hello world test");
    });

    test("collapses multiple spaces and tabs", () => {
      const result = filterText("hello   world\t\ttest");
      assert.strictEqual(result, "hello world test");
    });

    test("preserves newlines", () => {
      const result = filterText("hello\nworld");
      assert.strictEqual(result, "hello\nworld");
    });

    test("handles empty string", () => {
      assert.strictEqual(filterText(""), "");
    });

    test("handles DEL character (0x7f)", () => {
      assert.strictEqual(filterText("a\x7fb"), "a b");
    });

    test("unescape HTML entities", () => {
      assert.strictEqual(filterText("a&amp;b &lt;c&gt;"), "a&b <c>");
    });
  });

  suite("chunkStats", () => {
    test("returns null for zero length", () => {
      assert.strictEqual(chunkStats(Buffer.alloc(0), ""), null);
    });

    test("returns stats for clean text", () => {
      const buf = Buffer.alloc(100, 0x41);
      const stats = chunkStats(buf, buf.toString("utf-8"));
      assert.ok(stats);
      assert.strictEqual(stats!.totalBytes, 100);
      assert.strictEqual(stats!.replaced, 0);
      assert.strictEqual(stats!.isReadable, true);
    });

    test("detects replacement characters", () => {
      const buf = Buffer.from([0xff, 0xfe, 0xff, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47]);
      const text = buf.toString("utf-8");
      const stats = chunkStats(buf, text);
      assert.ok(stats);
      assert.ok(stats!.replaced > 0);
      assert.strictEqual(stats!.isReadable, true);
    });

    test("marks unreadable when too many replacements", () => {
      const buf = Buffer.alloc(100, 0xff);
      const text = buf.toString("utf-8");
      const stats = chunkStats(buf, text);
      assert.ok(stats);
      assert.strictEqual(stats!.isReadable, false);
    });

    test("computes encoding probe", () => {
      const buf = Buffer.from("hello world", "utf-8");
      const stats = chunkStats(buf, buf.toString("utf-8"));
      assert.ok(stats);
      assert.ok(stats!.encodingProbe.length > 0);
    });
  });

  suite("escapeHtml", () => {
    test("escapes ampersand", () => {
      assert.strictEqual(escapeHtml("a&b"), "a&amp;b");
    });

    test("escapes less than and greater than", () => {
      assert.strictEqual(escapeHtml("<div>"), "&lt;div&gt;");
    });

    test("escapes double quote", () => {
      assert.strictEqual(escapeHtml('say "hi"'), "say &quot;hi&quot;");
    });

    test("handles empty string", () => {
      assert.strictEqual(escapeHtml(""), "");
    });

    test("handles plain text", () => {
      assert.strictEqual(escapeHtml("hello world"), "hello world");
    });
  });

  suite("formatOffset", () => {
    test("formats bytes", () => {
      assert.strictEqual(formatOffset(0), "0 B");
      assert.strictEqual(formatOffset(42), "42 B");
    });

    test("formats kilobytes", () => {
      assert.strictEqual(formatOffset(1024), "1.0 KiB");
      assert.strictEqual(formatOffset(1536), "1.5 KiB");
    });

    test("formats megabytes", () => {
      assert.strictEqual(formatOffset(1048576), "1.00 MiB");
    });

    test("formats gigabytes", () => {
      assert.strictEqual(formatOffset(1024 * 1024 * 1024 * 2), "2.00 GiB");
    });

    test("formats terabytes", () => {
      assert.strictEqual(formatOffset(1024 * 1024 * 1024 * 1024 * 1.5), "1.50 TiB");
    });
  });

  suite("formatSize", () => {
    test("formats bytes", () => {
      assert.strictEqual(formatSize(0), "0 B");
      assert.strictEqual(formatSize(42), "42 B");
    });

    test("formats KB", () => {
      assert.strictEqual(formatSize(1024), "1.0 KB");
    });

    test("formats MB", () => {
      assert.strictEqual(formatSize(1048576), "1.0 MB");
    });

    test("formats GB", () => {
      assert.strictEqual(formatSize(1073741824), "1.00 GB");
    });
  });

  suite("byteToHex", () => {
    test("formats single digit", () => {
      assert.strictEqual(byteToHex(0), "00");
      assert.strictEqual(byteToHex(5), "05");
      assert.strictEqual(byteToHex(10), "0a");
    });

    test("formats double digit", () => {
      assert.strictEqual(byteToHex(255), "ff");
      assert.strictEqual(byteToHex(16), "10");
    });
  });

  suite("hexRow", () => {
    test("formats full row of 16 bytes", () => {
      const data = Buffer.from("Hello, World! 12", "utf-8");
      const row = hexRow(data, 0);
      assert.ok(row.startsWith("00000000"));
      assert.ok(row.includes("|Hello, World! 12|"));
    });

    test("pads short data", () => {
      const data = Buffer.from("AB", "utf-8");
      const row = hexRow(data, 0);
      assert.ok(row.startsWith("00000000"));
      assert.ok(row.includes("41 42"));
    });

    test("replaces non-printable chars with dot", () => {
      const data = Buffer.from([0x00, 0x01, 0x41]);
      const row = hexRow(data, 0);
      assert.ok(row.includes("..A"));
    });
  });

  suite("hexDump", () => {
    test("produces hex dump lines", () => {
      const data = Buffer.from("Hello, World!", "utf-8");
      const lines = hexDump(data, 0);
      assert.ok(lines.length > 0);
      assert.ok(lines[0].startsWith("00000000"));
    });

    test("limits output to HEX_DUMP_SIZE", () => {
      const data = Buffer.alloc(32768, 0x41);
      const lines = hexDump(data, 0);
      assert.strictEqual(lines.length, Math.ceil(16384 / 16));
    });
  });

  suite("probeEncoding", () => {
    test("returns sorted results", () => {
      const data = Buffer.from("hello world", "utf-8");
      const results = probeEncoding(data);
      assert.ok(results.length > 0);
      assert.ok(results[0].badPct <= results[results.length - 1].badPct);
    });

    test("ascii text has at least one encoding with low badPct", () => {
      const data = Buffer.from("The quick brown fox jumps", "utf-8");
      const results = probeEncoding(data);
      assert.ok(results.some(r => r.badPct < 10));
    });
  });

  suite("analyseChunk", () => {
    test("returns full analysis", () => {
      const data = Buffer.from("Hello, World! This is a test.", "utf-8");
      const result = analyseChunk(data, 0);
      assert.strictEqual(result.offset, 0);
      assert.strictEqual(result.bytesRead, data.length);
      assert.ok(result.stats);
      assert.ok(result.byteClasses);
    });

    test("finds bad ranges for bad data", () => {
      const data = Buffer.from([0xff, 0xfe, 0x41, 0x42, 0x00, 0x00, 0xff]);
      const result = analyseChunk(data, 100);
      assert.ok(result.badRangesTotal > 0);
    });
  });

  suite("findBadRanges", () => {
    test("finds 0xff/0xfe bytes as bad", () => {
      const data = Buffer.from([0x41, 0xff, 0xfe, 0x42]);
      const ranges = findBadRanges(data, 0);
      assert.ok(ranges.length > 0);
    });

    test("empty buffer has no bad ranges", () => {
      assert.strictEqual(findBadRanges(Buffer.alloc(0), 0).length, 0);
    });

    test("clean ascii has no bad ranges", () => {
      const data = Buffer.from("Hello, World!", "utf-8");
      assert.strictEqual(findBadRanges(data, 0).length, 0);
    });
  });

  suite("computeByteClasses", () => {
    test("counts null bytes", () => {
      const data = Buffer.from([0x00, 0x00, 0x41]);
      const classes = computeByteClasses(data);
      assert.strictEqual(classes.null, 2);
    });

    test("counts ascii printable", () => {
      const data = Buffer.from("ABC");
      const classes = computeByteClasses(data);
      assert.strictEqual(classes.ascii_print, 3);
    });

    test("counts control chars", () => {
      const data = Buffer.from([0x01, 0x02, 0x41]);
      const classes = computeByteClasses(data);
      assert.strictEqual(classes.control_01_1f, 2);
    });

    test("counts DEL", () => {
      const data = Buffer.from([0x7f, 0x7f]);
      const classes = computeByteClasses(data);
      assert.strictEqual(classes.del, 2);
    });

    test("counts UTF-8 start bytes", () => {
      const data = Buffer.from([0xc0, 0xe0, 0xf0]);
      const classes = computeByteClasses(data);
      assert.strictEqual(classes.utf8_start2, 1);
      assert.strictEqual(classes.utf8_start3, 1);
      assert.strictEqual(classes.utf8_start4, 1);
    });

    test("counts overlong BOM bytes", () => {
      const data = Buffer.from([0xfe, 0xff]);
      const classes = computeByteClasses(data);
      assert.strictEqual(classes.overlong_bom, 2);
    });
  });

  suite("isReadableChunk", () => {
    test("clean text is readable", () => {
      assert.strictEqual(isReadableChunk("Hello, World! This is a test."), true);
    });

    test("empty string is not readable", () => {
      assert.strictEqual(isReadableChunk(""), false);
    });

    test("mostly replacement chars is not readable", () => {
      const text = "\ufffd".repeat(90) + "hello";
      assert.strictEqual(isReadableChunk(text), false);
    });

    test("mixed text is readable", () => {
      const text = "\ufffd\ufffdHello, World!";
      assert.strictEqual(isReadableChunk(text), true);
    });
  });
});
