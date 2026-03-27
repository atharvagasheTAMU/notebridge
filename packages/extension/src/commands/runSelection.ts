import * as vscode from "vscode";
import type { BridgeClient, SessionInfo } from "../bridgeClient.js";
import type { OutputPanel } from "../outputPanel.js";
import type { StatusBarItem } from "../statusBar.js";

type RunPayload = { cellType: "code"; source: string } | { cellType: "markdown"; source: string };

/**
 * Run the active text selection (or current notebook cell) on the remote session.
 *
 * Code cells are pushed and executed on the kernel. Markdown cells are pushed as
 * text cells on Colab (no kernel run — same idea as “Run cell” rendering markdown).
 *
 * Contexts:
 *  1. `.py` editor — selection or whole file as code.
 *  2. `.ipynb` — focused / selected cells (code and/or markdown).
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

  const payload = getPayloadToRun();
  if (!payload) {
    notifyNothingToRun();
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
        cellType: payload.cellType,
        source: payload.source,
        outputs: [],
        executionCount: null,
        metadata: { transient: true },
      },
    ]);

    if (payload.cellType === "code") {
      const config = vscode.workspace.getConfiguration("notebookBridge");
      const timeoutMs: number = config.get("executionTimeoutMs") ?? 120_000;
      await client.runCells(session.id, [tempCellId], { timeoutMs });
    }

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
 * Builds what to send to the remote: code (run on kernel) or markdown (text cell only).
 */
function getPayloadToRun(): RunPayload | undefined {
  const notebookEditor = vscode.window.activeNotebookEditor;
  if (notebookEditor) {
    const notebook = notebookEditor.notebook;
    const selections = notebookEditor.selections;

    if (selections.length > 0) {
      const codeParts: string[] = [];
      const mdParts: string[] = [];
      for (const range of selections) {
        for (let i = range.start; i < range.end; i++) {
          const cell = notebook.cellAt(i);
          if (cell.kind === vscode.NotebookCellKind.Code) {
            codeParts.push(cell.document.getText());
          } else if (cell.kind === vscode.NotebookCellKind.Markup) {
            mdParts.push(cell.document.getText());
          }
        }
      }
      if (codeParts.length > 0) {
        const source = codeParts.map((s) => s.trim()).filter(Boolean).join("\n\n");
        return source ? { cellType: "code", source } : undefined;
      }
      if (mdParts.length > 0) {
        const source = mdParts.map((s) => s.trim()).filter(Boolean).join("\n\n");
        return source ? { cellType: "markdown", source } : undefined;
      }
    }

    const activeCellIndex = selections[0]?.start ?? 0;
    const activeCell = notebook.cellAt(activeCellIndex);
    if (activeCell?.kind === vscode.NotebookCellKind.Code) {
      const text = activeCell.document.getText().trim();
      return text ? { cellType: "code", source: text } : undefined;
    }
    if (activeCell?.kind === vscode.NotebookCellKind.Markup) {
      const text = activeCell.document.getText().trim();
      return text ? { cellType: "markdown", source: text } : undefined;
    }
    return undefined;
  }

  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const text = editor.selection.isEmpty
      ? editor.document.getText()
      : editor.document.getText(editor.selection);
    const trimmed = text.trim();
    return trimmed ? { cellType: "code", source: trimmed } : undefined;
  }

  return undefined;
}

function notifyNothingToRun(): void {
  const nb = vscode.window.activeNotebookEditor;
  if (nb) {
    const idx = nb.selections[0]?.start ?? 0;
    const cell = nb.notebook.cellAt(idx);
    if (cell && cell.kind !== vscode.NotebookCellKind.Code && cell.kind !== vscode.NotebookCellKind.Markup) {
      vscode.window.showInformationMessage(
        "Notebook Bridge: Only code and markdown cells can be sent to the remote session."
      );
      return;
    }
  }
  vscode.window.showWarningMessage("Notebook Bridge: Nothing to run.");
}
