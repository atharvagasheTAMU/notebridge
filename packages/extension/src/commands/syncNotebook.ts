import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import type { BridgeClient, SessionInfo } from "../bridgeClient.js";
import type { StatusBarItem } from "../statusBar.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>;

/**
 * Pull remote notebook state and save to local .ipynb file.
 */
export async function pullNotebook(
  client: BridgeClient,
  statusBar: StatusBarItem,
  session: SessionInfo | undefined
): Promise<void> {
  if (!session) {
    vscode.window.showWarningMessage("Notebook Bridge: No active session.");
    return;
  }

  try {
    const notebook: JsonObject = await client.pullNotebook(session.id);

    // Determine where to save
    const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
    const suggestedName = session.label.endsWith(".ipynb")
      ? session.label
      : `${session.label}.ipynb`;

    const saveUri = await vscode.window.showSaveDialog({
      ...(defaultUri ? { defaultUri: vscode.Uri.joinPath(defaultUri, suggestedName) } : {}),
      filters: { "Jupyter Notebooks": ["ipynb"] },
      title: "Save Pulled Notebook",
    });

    if (!saveUri) return;

    await fs.writeFile(
      saveUri.fsPath,
      JSON.stringify(notebook, null, 2),
      "utf-8"
    );

    vscode.window.showInformationMessage(
      `Notebook Bridge: Pulled → ${path.basename(saveUri.fsPath)}`
    );

    // Open the saved notebook
    await vscode.commands.executeCommand(
      "vscode.openWith",
      saveUri,
      "jupyter-notebook"
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    statusBar.update("error");
    vscode.window.showErrorMessage(`Notebook Bridge: Pull failed — ${message}`);
  }
}

/**
 * Push the currently open .ipynb or .py file to the remote session.
 * For .py files the NotebookSyncEngine parses `# %%` blocks first.
 */
export async function pushNotebook(
  client: BridgeClient,
  statusBar: StatusBarItem,
  session: SessionInfo | undefined
): Promise<void> {
  if (!session) {
    vscode.window.showWarningMessage("Notebook Bridge: No active session.");
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("Notebook Bridge: No active file open.");
    return;
  }

  const filePath = editor.document.uri.fsPath;
  const ext = path.extname(filePath).toLowerCase();

  try {
    let cells: JsonObject[];

    if (ext === ".ipynb") {
      const raw = JSON.parse(
        await fs.readFile(filePath, "utf-8")
      ) as JsonObject;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cells = (raw["cells"] as any[]) ?? [];
    } else {
      // .py or other script — treat whole file as a single code cell
      const source = editor.document.getText();
      cells = [
        {
          id: `cell-0`,
          cell_type: "code",
          source,
          outputs: [],
          execution_count: null,
          metadata: {},
        },
      ];
    }

    const confirm = await vscode.window.showWarningMessage(
      `Push ${cells.length} cell(s) to "${session.label}"? This will overwrite remote cells.`,
      { modal: true },
      "Push"
    );
    if (confirm !== "Push") return;

    statusBar.update("connecting", session.label);
    const updated = await client.pushCells(session.id, cells);

    if (updated.status === "sync_conflict") {
      statusBar.update("sync_conflict", session.label);
      const action = await vscode.window.showWarningMessage(
        "Notebook Bridge: Remote has conflicting changes. Force push?",
        "Force Push",
        "Cancel"
      );
      if (action === "Force Push") {
        await client.pushCells(session.id, cells, true);
        statusBar.update("attached", session.label);
      } else {
        statusBar.update("attached", session.label);
      }
    } else {
      statusBar.update("attached", session.label);
      vscode.window.showInformationMessage(
        `Notebook Bridge: Pushed ${cells.length} cell(s) to "${session.label}"`
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    statusBar.update("error");
    vscode.window.showErrorMessage(`Notebook Bridge: Push failed — ${message}`);
  }
}
