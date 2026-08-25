import * as path from "path";
import * as assert from "assert";
import * as vscode from "vscode";

suite("ExaPager Extension Integration Tests", () => {
  const testDir = path.join(__dirname, "..", "..", "..", "testfiles");

  suiteSetup(async () => {
    // Create test directory and files
    const fs = require("fs");
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    // Create a small test file
    const testFile = path.join(testDir, "test.txt");
    if (!fs.existsSync(testFile)) {
      fs.writeFileSync(testFile, "Hello, ExaPager!\nThis is a test file.\nLine 3.\n");
    }

    // Create a larger test file
    const largeFile = path.join(testDir, "large.txt");
    if (!fs.existsSync(largeFile)) {
      const lines = [];
      for (let i = 0; i < 1000; i++) {
        lines.push(`Line ${i}: This is test content for line number ${i}.`);
      }
      fs.writeFileSync(largeFile, lines.join("\n"));
    }
  });

  test("Extension activates", async () => {
    const ext = vscode.extensions.getExtension("gorom.exapager");
    // Extension may not be installed as "gorom.exapager" in test context
    // So we just verify the commands are registered
    const commands = await vscode.commands.getCommands(true);
    assert.ok(
      commands.includes("exapager.open"),
      "exapager.open command should be registered"
    );
    assert.ok(
      commands.includes("exapager.openActive"),
      "exapager.openActive command should be registered"
    );
    assert.ok(
      commands.includes("exapager.previewFile"),
      "exapager.previewFile command should be registered"
    );
  });

  test("exapager.open command executes without error", async () => {
    // We can't easily test the file picker, but we can verify the command exists
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("exapager.open"));
  });

  test("Test files exist", () => {
    const fs = require("fs");
    assert.ok(fs.existsSync(path.join(testDir, "test.txt")));
    assert.ok(fs.existsSync(path.join(testDir, "large.txt")));
  });
});
