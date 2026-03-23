/**
 * StatusBar — manages the single status bar item that shows the current
 * session state at a glance.
 */

import * as vscode from "vscode";
import type { SessionStatus } from "./bridgeClient.js";

const STATUS_LABELS: Record<SessionStatus, string> = {
  disconnected: "$(debug-disconnect) No Session",
  connecting: "$(loading~spin) Connecting…",
  attached: "$(plug) Attached",
  running: "$(loading~spin) Running…",
  sync_conflict: "$(warning) Sync Conflict",
  error: "$(error) Bridge Error",
};

const STATUS_TOOLTIPS: Record<SessionStatus, string> = {
  disconnected: "Click to attach to a notebook session",
  connecting: "Connecting to remote notebook…",
  attached: "Connected to remote notebook. Click for details.",
  running: "Executing cells on remote runtime…",
  sync_conflict: "Local and remote notebooks have conflicting changes. Pull or push with --force.",
  error: "Bridge encountered an error. Check the Output panel.",
};

export class StatusBarItem implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = "notebookBridge.attachSession";
    this.update("disconnected");
    this.item.show();
  }

  update(status: SessionStatus, label?: string): void {
    const base = STATUS_LABELS[status];
    this.item.text = label ? `${base} · ${label}` : base;
    this.item.tooltip = STATUS_TOOLTIPS[status];
    this.item.backgroundColor =
      status === "error" || status === "sync_conflict"
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : status === "running"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
