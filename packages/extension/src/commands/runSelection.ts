import * as vscode from "vscode";
import type { BridgeClient, SessionInfo } from "../bridgeClient.js";
import type { OutputPanel } from "../outputPanel.js";
import type { StatusBarItem } from "../statusBar.js";

/**
 * Run the active text selection (or current notebook cell) as a single code
 * cell on the remote session.
 *
 * Works in two contexts:
 *  1. A regular .py text editor — uses the text selection (or whole file).
 *  2. A .ipynb notebook editor — uses the focused cell's content.
 */
export async function runSelection(
  client: BridgeClient,
  outputPanel: OutputPanel,
  statusBar: StatusBarItem,
  session: SessionInfo | undefined
): Promise<void> {
  if (!session) {
    const attach = await vscode.window.showWarningMessage(
      "Notebook Bridge: No active session. Attach first.",
      "Attach Session"
    );
    if (attach) {
      await vscode.commands.executeCommand("notebookBridge.attachSession");
    }
    return;
  }

  // ── Resolve the code to execute ─────────────────────────────────────────
  const source = getSourceToRun();
  if (!source) {
    vscode.window.showWarningMessage("Notebook Bridge: Nothing to run.");
    return;
  }

  outputPanel.show();
  outputPanel.clear();
  statusBar.update("running", session.label);

  try {
    const tempCellId = `run-sel-${Date.now()}`;
    await client.pushCells(session.id, [
      {
        id: tempCellId,
        cellType: "code",
        source,
        outputs: [],
        executionCount: null,
        metadata: { transient: true },
      },
    ]);

    const config = vscode.workspace.getConfiguration("notebookBridge");
    const timeoutMs: number = config.get("executionTimeoutMs") ?? 120_000;

    await client.runCells(session.id, [tempCellId], { timeoutMs });

    statusBar.update("attached", session.label);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    statusBar.update("error");
    vscode.window.showErrorMessage(`Notebook Bridge: Run failed — ${message}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the code to run, checking notebook editor first, then text editor.
 * Returns undefined if nothing is found.
 */
function getSourceToRun(): string | undefined {
  // ── Notebook editor (`.ipynb`) ──────────────────────────────────────────
  const notebookEditor = vscode.window.activeNotebookEditor;
  if (notebookEditor) {
    const notebook = notebookEditor.notebook;
    const selections = notebookEditor.selections;

    if (selections.length > 0) {
      // Collect code from all selected cell ranges
      const parts: string[] = [];
      for (const range of selections) {
        for (let i = range.start; i < range.end; i++) {
          const cell = notebook.cellAt(i);
          if (cell.kind === vscode.NotebookCellKind.Code) {
            parts.push(cell.document.getText());
          }
        }
      }
      if (parts.length > 0) return parts.join("\n\n");
    }

    // No explicit selection — use the cell at the cursor (first selection start)
    const activeCellIndex = selections[0]?.start ?? 0;
    const activeCell = notebook.cellAt(activeCellIndex);
    if (activeCell?.kind === vscode.NotebookCellKind.Code) {
      return activeCell.document.getText();
    }

    // Fallback: use every code cell
    const allCode = Array.from({ length: notebook.cellCount }, (_, i) => notebook.cellAt(i))
      .filter((c) => c.kind === vscode.NotebookCellKind.Code)
      .map((c) => c.document.getText())
      .join("\n\n");
    return allCode.trim() || undefined;
  }

  // ── Text editor (`.py` or any other file) ──────────────────────────────
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const text = editor.selection.isEmpty
      ? editor.document.getText()
      : editor.document.getText(editor.selection);
    return text.trim() || undefined;
  }

  return undefined;
}
