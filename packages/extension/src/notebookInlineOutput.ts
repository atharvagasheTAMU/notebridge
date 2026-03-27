/**
 * Mirrors remote execution output into the local .ipynb cell using the notebook
 * output API (same region as built-in Jupyter cell outputs).
 *
 * VS Code 1.85: cell outputs are updated via NotebookEdit.replaceCells + NotebookCellData
 * (there is no NotebookEdit.updateCellOutputs yet).
 */

import * as vscode from "vscode";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>;

interface Pending {
  sessionId: string;
  bridgeCellId: string;
  uri: vscode.Uri;
  cellIndex: number;
}

let pending: Pending | undefined;
let stdout = "";
let stderr = "";
let displayOutputs: vscode.NotebookCellOutput[] = [];
let errorItems: vscode.NotebookCellOutputItem[] | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/** First selected code cell index, or the active cell index (for code runs). */
export function getInlineOutputAnchorCellIndex(notebookEditor: vscode.NotebookEditor): number {
  const notebook = notebookEditor.notebook;
  const selections = notebookEditor.selections;
  if (selections.length > 0) {
    let firstCode = -1;
    for (const range of selections) {
      for (let i = range.start; i < range.end; i++) {
        const cell = notebook.cellAt(i);
        if (cell.kind === vscode.NotebookCellKind.Code) {
          if (firstCode < 0) firstCode = i;
        }
      }
    }
    if (firstCode >= 0) return firstCode;
  }
  return selections[0]?.start ?? 0;
}

export function armNotebookInlineOutput(target: Pending): void {
  pending = { ...target };
  stdout = "";
  stderr = "";
  displayOutputs = [];
  errorItems = undefined;
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  void applyOutputsToCell(target.uri, target.cellIndex, []);
}

export function handleNotebookBridgeEventForInlineOutput(event: JsonObject): void {
  if (!matches(event)) return;
  const kind = String(event["kind"] ?? "");

  if (kind === "stream") {
    const stream = String(event["stream"] ?? "stdout");
    const text = String(event["text"] ?? "");
    if (stream === "stderr") stderr += text;
    else stdout += text;
    scheduleFlush();
    return;
  }

  if (kind === "display") {
    const out = displayEventToNotebookOutput(event);
    if (out) displayOutputs.push(out);
    scheduleFlush();
    return;
  }

  if (kind === "error") {
    const ename = String(event["ename"] ?? "Error");
    const evalue = String(event["evalue"] ?? "");
    const traceback = (event["traceback"] as string[] | undefined) ?? [];
    const msg = [evalue, ...traceback].filter(Boolean).join("\n") || ename;
    const err = new Error(msg);
    err.name = ename;
    errorItems = [vscode.NotebookCellOutputItem.error(err)];
    flushNow();
    return;
  }

  if (kind === "status") {
    const s = String(event["status"] ?? "");
    if (s === "idle" || s === "error") {
      flushNow();
      pending = undefined;
    }
  }
}

function matches(event: JsonObject): boolean {
  if (!pending) return false;
  if (String(event["sessionId"] ?? "") !== pending.sessionId) return false;
  const cid = event["cellId"];
  if (cid === undefined || cid === null) return false;
  return String(cid) === pending.bridgeCellId;
}

function displayEventToNotebookOutput(event: JsonObject): vscode.NotebookCellOutput | undefined {
  const mime = String(event["mimeType"] ?? "text/plain");
  const data = String(event["data"] ?? "");
  try {
    if (mime.startsWith("image/")) {
      const buf = Buffer.from(data, "base64");
      return new vscode.NotebookCellOutput([new vscode.NotebookCellOutputItem(buf, mime)]);
    }
    return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(data, mime)]);
  } catch {
    return new vscode.NotebookCellOutput([
      vscode.NotebookCellOutputItem.text(`[${mime}] (could not decode)`, "text/plain"),
    ]);
  }
}

function buildOutputs(): vscode.NotebookCellOutput[] {
  const list: vscode.NotebookCellOutput[] = [];
  if (stdout) {
    list.push(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stdout(stdout)]));
  }
  if (stderr) {
    list.push(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stderr(stderr)]));
  }
  list.push(...displayOutputs);
  if (errorItems?.length) {
    list.push(new vscode.NotebookCellOutput(errorItems));
  }
  return list;
}

function scheduleFlush(): void {
  if (flushTimer !== undefined) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flush();
  }, 50);
}

function flushNow(): void {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  flush();
}

function flush(): void {
  if (!pending) return;
  const outputs = buildOutputs();
  void applyOutputsToCell(pending.uri, pending.cellIndex, outputs);
}

function cellDataPreservingSource(cell: vscode.NotebookCell, outputs: vscode.NotebookCellOutput[]): vscode.NotebookCellData {
  const data = new vscode.NotebookCellData(
    cell.kind,
    cell.document.getText(),
    cell.document.languageId
  );
  data.outputs = outputs;
  data.metadata = { ...cell.metadata };
  if (cell.executionSummary !== undefined) {
    data.executionSummary = cell.executionSummary;
  }
  return data;
}

function applyOutputsToCell(uri: vscode.Uri, cellIndex: number, outputs: vscode.NotebookCellOutput[]): void {
  const doc = vscode.workspace.notebookDocuments.find((d) => d.uri.toString() === uri.toString());
  if (!doc || cellIndex < 0 || cellIndex >= doc.cellCount) return;
  const cell = doc.cellAt(cellIndex);
  const data = cellDataPreservingSource(cell, outputs);
  const edit = new vscode.WorkspaceEdit();
  edit.set(uri, [
    vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(cellIndex, cellIndex + 1), [data]),
  ]);
  void vscode.workspace.applyEdit(edit);
}
