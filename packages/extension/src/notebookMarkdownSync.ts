/**
 * After pushing a markdown cell to Colab, pull the remote notebook and copy the
 * canonical source from the newly appended text cell back into the local cell.
 */

import * as vscode from "vscode";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>;

/** First selected markdown cell index, or active cell index. */
export function getMarkdownAnchorCellIndex(editor: vscode.NotebookEditor): number {
  const notebook = editor.notebook;
  const selections = editor.selections;
  if (selections.length > 0) {
    let firstMd = -1;
    for (const range of selections) {
      for (let i = range.start; i < range.end; i++) {
        if (notebook.cellAt(i).kind === vscode.NotebookCellKind.Markup) {
          if (firstMd < 0) firstMd = i;
        }
      }
    }
    if (firstMd >= 0) return firstMd;
  }
  return selections[0]?.start ?? 0;
}

function extractIpynbSource(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map(String).join("");
  return "";
}

function remoteCellIsMarkdown(cell: JsonObject): boolean {
  const t = cell["cellType"] ?? cell["cell_type"];
  return t === "markdown";
}

function cloneCellOutputs(cell: vscode.NotebookCell): vscode.NotebookCellOutput[] {
  return cell.outputs.map(
    (o) =>
      new vscode.NotebookCellOutput(
        o.items.map((it) => new vscode.NotebookCellOutputItem(new Uint8Array(it.data), it.mime)),
        o.metadata
      )
  );
}

async function replaceMarkupCellSource(
  uri: vscode.Uri,
  cellIndex: number,
  source: string
): Promise<void> {
  const doc = vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === uri.toString());
  if (!doc || cellIndex < 0 || cellIndex >= doc.cellCount) return;
  const cell = doc.cellAt(cellIndex);
  if (cell.kind !== vscode.NotebookCellKind.Markup) return;
  if (cell.document.getText() === source) return;

  const data = new vscode.NotebookCellData(cell.kind, source, cell.document.languageId);
  data.metadata = { ...cell.metadata };
  if (cell.executionSummary !== undefined) {
    data.executionSummary = cell.executionSummary;
  }
  data.outputs = cloneCellOutputs(cell);

  const edit = new vscode.WorkspaceEdit();
  edit.set(uri, [
    vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(cellIndex, cellIndex + 1), [data]),
  ]);
  await vscode.workspace.applyEdit(edit);
}

/**
 * We append one markdown cell on Colab per run; that cell is the last one in get_cells.
 */
export async function syncLocalMarkdownFromLastRemoteCell(
  uri: vscode.Uri,
  localCellIndex: number,
  remoteNotebook: JsonObject
): Promise<void> {
  const cells = remoteNotebook["cells"] as JsonObject[] | undefined;
  if (!cells?.length) return;
  const last = cells[cells.length - 1];
  if (!last || !remoteCellIsMarkdown(last)) return;
  const source = extractIpynbSource(last["source"]);
  await replaceMarkupCellSource(uri, localCellIndex, source);
}
