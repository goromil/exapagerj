import * as fs from "fs";
import * as path from "path";

export function getWebviewHtml(): string {
  return fs.readFileSync(path.join(__dirname, "webview.html"), "utf-8");
}
