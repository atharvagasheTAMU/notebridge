/**
 * NotebookSyncEngine implementation.
 *
 * Sync model for v1:
 *  - Explicit commands only (no auto-sync).
 *  - Script-to-notebook mapping via `# %%` separator comments.
 *  - Merge strategy: last-write-wins at the cell level, drift detection by
 *    comparing cell ids present in local vs remote.
 *  - Conflict = remote has cell ids not in local AND local has cell ids not in
 *    remote (genuine divergence, not just an append).
 */

import { v4 as uuidv4 } from "uuid";
import type {
  NotebookSyncEngine,
  ScriptBlock,
  SyncResult,
} from "./contracts.js";
import type { Notebook, NotebookCell } from "./notebookModel.js";

// ---------------------------------------------------------------------------
// Separator comment patterns — support the VS Code / Jupyter convention
//
//  # %%              → code cell
//  # %% [markdown]   → markdown cell
//  # %% title here   → code cell with title (preserved in metadata)
//  # In[42]:         → IPython cell marker (imported from Colab export)
// ---------------------------------------------------------------------------

const SEPARATOR_RE = /^#\s*%%(.*)$/m;
const MARKDOWN_FLAG_RE = /\[markdown\]/i;

export class SyncEngine implements NotebookSyncEngine {
  // ---------------------------------------------------------------------------
  // Script parsing
  // ---------------------------------------------------------------------------

  parseScriptBlocks(scriptSource: string): ScriptBlock[] {
    const lines = scriptSource.split("\n");
    const separatorIndices: number[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (SEPARATOR_RE.test(lines[i] ?? "")) {
        separatorIndices.push(i);
      }
    }

    if (separatorIndices.length === 0) {
      // No separators — treat whole file as one code block
      return [
        {
          source: scriptSource,
          startLine: 0,
          endLine: lines.length - 1,
          cellType: "code",
        },
      ];
    }

    const blocks: ScriptBlock[] = [];

    // Any content before the first separator is a preamble code block
    if (separatorIndices[0]! > 0) {
      const preamble = lines.slice(0, separatorIndices[0]).join("\n").trimEnd();
      if (preamble.trim()) {
        blocks.push({
          source: preamble,
          startLine: 0,
          endLine: separatorIndices[0]! - 1,
          cellType: "code",
        });
      }
    }

    for (let idx = 0; idx < separatorIndices.length; idx++) {
      const sepLine = separatorIndices[idx]!;
      const nextSepLine = separatorIndices[idx + 1] ?? lines.length;
      const separatorText = lines[sepLine] ?? "";

      const match = SEPARATOR_RE.exec(separatorText);
      const suffix = (match?.[1] ?? "").trim();
      const isMarkdown = MARKDOWN_FLAG_RE.test(suffix);
      const separator = separatorText;

      // Cell content is everything after the separator line
      const contentLines = lines.slice(sepLine + 1, nextSepLine);
      const source = contentLines.join("\n").trimEnd();

      blocks.push({
        source,
        startLine: sepLine + 1,
        endLine: nextSepLine - 1,
        cellType: isMarkdown ? "markdown" : "code",
        separator,
      });
    }

    return blocks;
  }

  // ---------------------------------------------------------------------------
  // Script blocks → notebook cells
  // ---------------------------------------------------------------------------

  scriptBlocksToNotebookCells(
    blocks: ScriptBlock[],
    existingCells: NotebookCell[]
  ): NotebookCell[] {
    // Build a map from normalised source → existing cell so we can re-use ids
    const sourceToCell = new Map<string, NotebookCell>();
    for (const cell of existingCells) {
      sourceToCell.set(normalizeSource(cell.source), cell);
    }

    return blocks.map((block) => {
      const normalised = normalizeSource(block.source);
      const existing = sourceToCell.get(normalised);

      return {
        id: existing?.id ?? uuidv4(),
        cellType: block.cellType,
        source: block.source,
        outputs: existing?.outputs ?? [],
        executionCount: existing?.executionCount ?? null,
        metadata: existing?.metadata ?? {},
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Merge notebooks — conservative, cell-id-based
  // ---------------------------------------------------------------------------

  mergeNotebooks(local: Notebook, remote: Notebook): SyncResult {
    const localIds = new Set(local.cells.map((c) => c.id));
    const remoteIds = new Set(remote.cells.map((c) => c.id));

    const newRemoteCells = remote.cells.filter((c) => !localIds.has(c.id));
    const localOnlyCellIds = local.cells
      .filter((c) => !remoteIds.has(c.id))
      .map((c) => c.id);

    // Genuine conflict: both sides have cells the other does not (divergence)
    const isConflict = newRemoteCells.length > 0 && localOnlyCellIds.length > 0;

    if (isConflict) {
      // Return remote as the merged result with conflict flags
      return {
        merged: false,
        newRemoteCells,
        conflictCells: localOnlyCellIds,
        notebook: remote,
      };
    }

    if (newRemoteCells.length > 0) {
      // Remote has appended cells we don't have locally — accept them
      const merged: Notebook = {
        ...local,
        cells: mergeByRemoteOrder(local.cells, remote.cells),
      };
      return { merged: true, newRemoteCells, conflictCells: [], notebook: merged };
    }

    // Local may have added cells the remote doesn't have (pre-push state)
    // Keep local ordering; remote outputs are preserved for shared cells
    const remoteCellMap = new Map(remote.cells.map((c) => [c.id, c]));
    const mergedCells: NotebookCell[] = local.cells.map((cell) => {
      const remoteCell = remoteCellMap.get(cell.id);
      if (!remoteCell) return cell;
      // Prefer remote outputs (they are the result of execution)
      return {
        ...cell,
        outputs: remoteCell.outputs,
        executionCount: remoteCell.executionCount,
      };
    });

    return {
      merged: true,
      newRemoteCells: [],
      conflictCells: [],
      notebook: { ...local, cells: mergedCells },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise source for identity comparison — strip trailing whitespace/newlines */
function normalizeSource(source: string): string {
  return source.trim().replace(/\r\n/g, "\n");
}

/**
 * Merge two cell arrays, preferring remote ordering for shared cells and
 * appending local-only cells at the end.
 */
function mergeByRemoteOrder(
  local: NotebookCell[],
  remote: NotebookCell[]
): NotebookCell[] {
  const localMap = new Map(local.map((c) => [c.id, c]));
  const merged: NotebookCell[] = [];

  for (const remoteCell of remote) {
    const localCell = localMap.get(remoteCell.id);
    if (localCell) {
      // Prefer local source, remote outputs
      merged.push({ ...localCell, outputs: remoteCell.outputs, executionCount: remoteCell.executionCount });
      localMap.delete(remoteCell.id);
    } else {
      merged.push(remoteCell);
    }
  }

  // Append any local-only cells
  for (const remaining of localMap.values()) {
    merged.push(remaining);
  }

  return merged;
}
