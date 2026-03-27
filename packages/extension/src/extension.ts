/**
 * Extension entry point.
 *
 * activate() returns immediately — all commands are registered synchronously
 * so the extension host never times out.  The bridge process starts in the
 * background and the status bar shows "Starting…" until it is ready.
 *
 * This avoids the "Extension host did not start in 10 seconds" error that
 * occurs when activate() awaits a slow async operation.
 */

import * as vscode from "vscode";
import { BridgeClient } from "./bridgeClient.js";
import { StatusBarItem } from "./statusBar.js";
import { OutputPanel } from "./outputPanel.js";
import { RichOutputPanel } from "./richOutputPanel.js";
import { startBridgeProcess } from "./bridgeProcess.js";
import { attachSession } from "./commands/attachSession.js";
import { runSelection } from "./commands/runSelection.js";
import { pullNotebook, pushNotebook } from "./commands/syncNotebook.js";
import { mountGoogleDrive } from "./commands/mountDrive.js";
import type { SessionInfo } from "./bridgeClient.js";

let bridgeClient: BridgeClient | undefined;
let activeSession: SessionInfo | undefined;
let bridgeReady = false;

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("notebookBridge");
  const port: number = config.get("bridgePort") ?? 52000;

  const statusBar = new StatusBarItem();
  const outputPanel = new OutputPanel();
  const richOutputPanel = new RichOutputPanel(context);

  context.subscriptions.push(statusBar, outputPanel, richOutputPanel);

  // Show "starting" state immediately so the user knows something is happening
  statusBar.update("connecting");

  // ---------------------------------------------------------------------------
  // Register all commands synchronously so the host never times out.
  // Each command checks bridgeReady and shows a message if not ready yet.
  // ---------------------------------------------------------------------------

  const requireBridge = async (
    fn: (client: BridgeClient) => Promise<void>
  ): Promise<void> => {
    if (!bridgeClient || !bridgeReady) {
      vscode.window.showWarningMessage(
        "Notebook Bridge is still starting. Please wait a moment and try again."
      );
      return;
    }
    await fn(bridgeClient);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("notebookBridge.attachSession", () =>
      requireBridge(async (client) => {
        const session = await attachSession(client, statusBar);
        if (session) activeSession = session;
      })
    ),

    vscode.commands.registerCommand("notebookBridge.runSelection", () =>
      requireBridge((client) =>
        runSelection(client, outputPanel, statusBar, activeSession)
      )
    ),

    vscode.commands.registerCommand("notebookBridge.runFile", () =>
      requireBridge(async (client) => {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const allRange = new vscode.Range(
            editor.document.lineAt(0).range.start,
            editor.document.lineAt(editor.document.lineCount - 1).range.end
          );
          editor.selection = new vscode.Selection(allRange.start, allRange.end);
        }
        await runSelection(client, outputPanel, statusBar, activeSession);
      })
    ),

    vscode.commands.registerCommand("notebookBridge.pullNotebook", () =>
      requireBridge((client) => pullNotebook(client, statusBar, activeSession))
    ),

    vscode.commands.registerCommand("notebookBridge.pushNotebook", () =>
      requireBridge((client) => pushNotebook(client, statusBar, activeSession))
    ),

    vscode.commands.registerCommand("notebookBridge.showOutput", () => {
      outputPanel.show();
    }),

    vscode.commands.registerCommand("notebookBridge.showRichOutput", () => {
      richOutputPanel.show();
    }),

    vscode.commands.registerCommand("notebookBridge.mountDrive", () =>
      requireBridge((client) =>
        mountGoogleDrive(client, outputPanel, statusBar, activeSession)
      )
    ),

    vscode.commands.registerCommand("notebookBridge.disconnect", () =>
      requireBridge(async (client) => {
        if (!activeSession) {
          vscode.window.showInformationMessage(
            "Notebook Bridge: No active session to disconnect."
          );
          return;
        }
        try {
          await client.disconnect(activeSession.id);
          activeSession = undefined;
          statusBar.update("disconnected");
          vscode.window.showInformationMessage("Notebook Bridge: Disconnected.");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(
            `Notebook Bridge: Disconnect failed — ${message}`
          );
        }
      })
    )
  );

  // ---------------------------------------------------------------------------
  // Start bridge process in the background — does NOT block activation.
  // ---------------------------------------------------------------------------

  startBridgeInBackground(context, port, statusBar, outputPanel, richOutputPanel);
}

function startBridgeInBackground(
  context: vscode.ExtensionContext,
  port: number,
  statusBar: StatusBarItem,
  outputPanel: OutputPanel,
  richOutputPanel: RichOutputPanel
): void {
  startBridgeProcess(context, port)
    .then((info) => {
      bridgeClient = new BridgeClient(info.port);
      context.subscriptions.push(bridgeClient);

      context.subscriptions.push(
        bridgeClient.onEvent.event((event) => {
          // Route display events to the rich panel first; if handled, suppress
          // the placeholder text the text channel would have emitted instead.
          const handledByRich = richOutputPanel.handleEvent(event);
          if (!handledByRich) {
            outputPanel.handleEvent(event);
          }

          if (event["kind"] === "session_changed") {
            const s = event["status"] as string;
            if (s === "disconnected" || s === "error") {
              statusBar.update(
                s === "error" ? "error" : "disconnected",
                activeSession?.label
              );
            }
          }

          if (event["kind"] === "status") {
            const s = event["status"] as string;
            if (s === "running") {
              // New execution starting — clear the rich output panel
              richOutputPanel.clear();
              statusBar.update("running", activeSession?.label);
            }
            if (s === "idle") statusBar.update("attached", activeSession?.label);
            if (s === "error") statusBar.update("error", activeSession?.label);
          }
        })
      );

      bridgeReady = true;
      statusBar.update("disconnected");
      console.log(`[Notebook Bridge] Bridge started on port ${info.port}`);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      statusBar.update("error");
      console.error(`[Notebook Bridge] Bridge failed to start: ${message}`);
      vscode.window.showErrorMessage(
        `Notebook Bridge: Could not start bridge service — ${message}`
      );
    });
}

export function deactivate(): void {
  bridgeClient?.dispose();
}
