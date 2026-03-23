import * as vscode from "vscode";
import type { BridgeClient, SessionInfo } from "../bridgeClient.js";
import type { StatusBarItem } from "../statusBar.js";

export async function attachSession(
  client: BridgeClient,
  statusBar: StatusBarItem
): Promise<SessionInfo | undefined> {
  const config = vscode.workspace.getConfiguration("notebookBridge");
  const defaultBackend: string = config.get("defaultBackend") ?? "colab";

  // 1. Ask for the notebook URI
  const notebookUri = await vscode.window.showInputBox({
    title: "Attach to Notebook Session",
    prompt: "Enter a Colab URL, notebook path, or leave blank to create a new notebook",
    placeHolder: "https://colab.research.google.com/drive/...",
    ignoreFocusOut: true,
  });

  if (notebookUri === undefined) return; // user cancelled

  statusBar.update("connecting");

  try {
    // 2. Check for existing sessions to offer re-use
    let existingSessionId: string | undefined;

    if (notebookUri) {
      const existing = await client.listSessions(defaultBackend);
      const match = existing.find(
        (s) => s.notebookUri === notebookUri || s.id === notebookUri
      );
      if (match) {
        const reuse = await vscode.window.showQuickPick(["Reuse existing session", "Create new"], {
          title: `Session "${match.label}" already attached`,
        });
        if (reuse === "Reuse existing session") {
          existingSessionId = match.id;
        }
      }
    }

    // 3. Connect
    const session = await client.connect(
      defaultBackend,
      notebookUri || `untitled-${Date.now()}.ipynb`,
      existingSessionId
    );

    statusBar.update(session.status, session.label);

    // 4. Subscribe to events over WS
    client.subscribeToSession(session.id);

    vscode.window.showInformationMessage(
      `Notebook Bridge: Attached to "${session.label}" (${defaultBackend})`
    );

    return session;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    statusBar.update("error");
    vscode.window.showErrorMessage(`Notebook Bridge: Failed to attach — ${message}`);
    return undefined;
  }
}
