/**
 * OutputPanel — wraps a VS Code OutputChannel and formats incoming
 * ExecutionEvents for display.
 */

import * as vscode from "vscode";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExecutionEvent = Record<string, any>;

export class OutputPanel implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel(
      "Notebook Bridge",
      "log"
    );
  }

  show(): void {
    this.channel.show(true);
  }

  handleEvent(event: ExecutionEvent): void {
    const kind = String(event["kind"] ?? "unknown");
    const cellId: string = event["cellId"] ? `[${event["cellId"]}] ` : "";

    switch (kind) {
      case "stream":
        this.channel.append(`${cellId}${String(event["text"] ?? "")}`);
        break;

      case "display":
        // Rich types (images, HTML, JSON, LaTeX) are rendered in the
        // RichOutputPanel webview — only log a brief notice here so the
        // text channel stays readable.
        if (String(event["mimeType"]).startsWith("image/")) {
          this.channel.appendLine(`${cellId}[image — shown in Notebook Output panel]`);
        } else if (event["mimeType"] === "text/html") {
          this.channel.appendLine(`${cellId}[HTML — shown in Notebook Output panel]`);
        } else if (event["mimeType"] === "text/plain") {
          this.channel.appendLine(`${cellId}${String(event["data"] ?? "")}`);
        } else {
          this.channel.appendLine(
            `${cellId}[${event["mimeType"]}] ${String(event["data"] ?? "").slice(0, 200)}`
          );
        }
        break;

      case "error":
        this.channel.appendLine(
          `${cellId}ERROR: ${event["ename"]}: ${event["evalue"]}`
        );
        for (const line of (event["traceback"] as string[] | undefined) ?? []) {
          this.channel.appendLine(`  ${line}`);
        }
        break;

      case "status":
        this.channel.appendLine(
          `${cellId}[${String(event["status"]).toUpperCase()}] ${event["message"] ?? ""}`
        );
        break;

      case "notebook_changed":
        this.channel.appendLine(`[notebook_changed] Remote notebook updated.`);
        break;

      case "session_changed":
        this.channel.appendLine(
          `[session] ${event["status"]}${event["detail"] ? ": " + event["detail"] : ""}`
        );
        break;

      default:
        this.channel.appendLine(`[${kind}] ${JSON.stringify(event)}`);
    }
  }

  clear(): void {
    this.channel.clear();
  }

  dispose(): void {
    this.channel.dispose();
  }
}
