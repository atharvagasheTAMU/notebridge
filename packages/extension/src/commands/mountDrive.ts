import * as vscode from "vscode";
import type { BridgeClient, SessionInfo } from "../bridgeClient.js";
import type { OutputPanel } from "../outputPanel.js";
import type { StatusBarItem } from "../statusBar.js";

const MOUNT_SOURCE = `from google.colab import drive
drive.mount("/content/drive")
print("Google Drive mounted at /content/drive")
print("Your files are at: /content/drive/MyDrive/")`;

/**
 * Mount Google Drive in the active Colab session.
 *
 * Pushes a single transient cell that runs `drive.mount("/content/drive")`.
 * After it executes, the user can reference any Drive file via
 * /content/drive/MyDrive/<filename> for the rest of the session.
 */
export async function mountGoogleDrive(
  client: BridgeClient,
  outputPanel: OutputPanel,
  statusBar: StatusBarItem,
  session: SessionInfo | undefined
): Promise<void> {
  if (!session) {
    const attach = await vscode.window.showWarningMessage(
      "Notebook Bridge: No active session. Attach to a Colab session first.",
      "Attach Session"
    );
    if (attach) {
      await vscode.commands.executeCommand("notebookBridge.attachSession");
    }
    return;
  }

  const confirm = await vscode.window.showInformationMessage(
    "Mount Google Drive in the active Colab session?\n" +
      "Colab will prompt you to authorise access in the browser.",
    { modal: true },
    "Mount Drive"
  );
  if (!confirm) return;

  outputPanel.show();
  statusBar.update("running", session.label);

  const cellId = `mount-drive-${Date.now()}`;

  try {
    await client.pushCells(session.id, [
      {
        id: cellId,
        cellType: "code",
        source: MOUNT_SOURCE,
        outputs: [],
        executionCount: null,
        metadata: { transient: true },
      },
    ]);

    const config = vscode.workspace.getConfiguration("notebookBridge");
    // Drive mount triggers a browser auth prompt — give it extra time
    const timeoutMs: number = (config.get("executionTimeoutMs") ?? 120_000) as number;

    await client.runCells(session.id, [cellId], { timeoutMs });

    statusBar.update("attached", session.label);
    vscode.window.showInformationMessage(
      "Google Drive mounted. Access your files at /content/drive/MyDrive/"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    statusBar.update("error");
    vscode.window.showErrorMessage(
      `Notebook Bridge: Drive mount failed — ${message}`
    );
  }
}
