/**
 * ColabBackend — implements NotebookBackend using the verified colab-mcp tool set.
 *
 * Verified tool list (2026-03-23):
 *   open_colab_browser_connection  → no args, returns true
 *   add_code_cell    cellIndex(req), language(req), code
 *   add_text_cell    cellIndex(req), content
 *   update_cell      cellId(req), content
 *   delete_cell      cellId
 *   move_cell        cellId(req), cellIndex(req)
 *   get_cells        cellIndexStart, cellIndexEnd, includeOutputs
 *   run_code_cell    cellId
 */

import { homedir } from "os";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import { ColabMcpClient } from "./mcpClient.js";
import type {
  NotebookBackend,
  BackendCapabilities,
  Session,
  RunCellsOptions,
  PushOptions,
  PullOptions,
} from "@cursor-notebook-bridge/core";
import { deserializeNotebook, makeEvent } from "@cursor-notebook-bridge/core";
import type {
  Notebook,
  NotebookCell,
  ExecutionEvent,
  StatusEvent,
  StreamEvent,
  ErrorEvent,
  DisplayEvent,
  NotebookChangedEvent,
} from "@cursor-notebook-bridge/core";

// ---------------------------------------------------------------------------
// Cell map persistence
// Cell ID mappings (ourId → colabId) are persisted to disk so they survive
// bridge restarts.  Keyed by notebookUri so different notebooks don't collide.
// ---------------------------------------------------------------------------

const STORE_DIR = join(homedir(), ".cursor-notebook-bridge");
const STORE_FILE = join(STORE_DIR, "cellmap.json");

type PersistedStore = Record<string, Record<string, string>>;

function loadStore(): Map<string, Map<string, string>> {
  try {
    const raw = readFileSync(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as PersistedStore;
    return new Map(
      Object.entries(parsed).map(([uri, map]) => [uri, new Map(Object.entries(map))])
    );
  } catch {
    return new Map();
  }
}

function saveStore(store: Map<string, Map<string, string>>): void {
  try {
    mkdirSync(STORE_DIR, { recursive: true });
    const obj: PersistedStore = {};
    for (const [uri, map] of store) {
      obj[uri] = Object.fromEntries(map);
    }
    writeFileSync(STORE_FILE, JSON.stringify(obj, null, 2), "utf-8");
  } catch (err) {
    console.warn("[ColabBackend] Could not save cell map:", err);
  }
}

export class ColabBackend implements NotebookBackend {
  readonly id = "colab";
  readonly displayName = "Google Colab";

  readonly capabilities: BackendCapabilities = {
    supportsStreamingOutput: false,
    supportsNotebookStructureEdit: true,
    supportsRichOutput: true,
    requiresBrowserSession: true,
  };

  private readonly mcp: ColabMcpClient;
  private readonly sessionMap = new Map<string, Session>();
  private proxyConnected = false;
  /** Maps our internal cell IDs → Colab-assigned cell IDs (in-memory working copy) */
  private readonly cellIdMap = new Map<string, string>();
  /** Persisted store: notebookUri → (ourCellId → colabCellId) */
  private readonly persistedMaps: Map<string, Map<string, string>>;

  constructor(mcpClient?: ColabMcpClient) {
    this.mcp = mcpClient ?? new ColabMcpClient();
    this.persistedMaps = loadStore();
    console.log(`[ColabBackend] Loaded persisted cell maps for ${this.persistedMaps.size} notebook(s)`);
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  async listSessions(): Promise<Session[]> {
    return Array.from(this.sessionMap.values());
  }

  async connect(notebookUri: string, existingSessionId?: string): Promise<Session> {
    await this.mcp.connect();

    const sessionId = existingSessionId ?? uuidv4();

    // Step 1: open the browser proxy connection
    try {
      const result = await this.mcp.openBrowserConnection();
      const ok = result === true || (typeof result === "object" && result !== null);
      if (ok) {
        // Step 2: re-discover tools — server registers the full set after connect
        await this.mcp.rediscoverTools();
        this.proxyConnected = true;
        console.log(`[ColabBackend] Proxy connected. Tools: ${this.mcp.getAvailableTools().join(", ")}`);
      }
    } catch (err) {
      console.warn("[ColabBackend] Browser connection failed:", err);
    }

    const label = notebookUri.split("/").pop()?.replace(/\?.*$/, "") ?? notebookUri;
    const session: Session = {
      id: sessionId,
      status: "attached",
      label,
      notebookUri,
      backendId: this.id,
      connectedAt: new Date().toISOString(),
    };

    this.sessionMap.set(sessionId, session);

    // Restore any cell ID mappings saved from a previous session for this notebook
    const saved = this.persistedMaps.get(notebookUri);
    if (saved && saved.size > 0) {
      for (const [ourId, colabId] of saved) {
        this.cellIdMap.set(ourId, colabId);
      }
      console.log(`[ColabBackend] Restored ${saved.size} cell ID mapping(s) for ${notebookUri}`);
    }

    return session;
  }

  async disconnect(sessionId: string): Promise<void> {
    const notebookUri = this.sessionMap.get(sessionId)?.notebookUri;
    this.sessionMap.delete(sessionId);
    this.proxyConnected = false;
    this.cellIdMap.clear();

    // Remove persisted mappings for this notebook on explicit disconnect so a
    // fresh attach next time starts without stale Colab cell IDs.
    if (notebookUri) {
      this.persistedMaps.delete(notebookUri);
      saveStore(this.persistedMaps);
      console.log(`[ColabBackend] Cleared persisted cell map for ${notebookUri}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Notebook operations
  // ---------------------------------------------------------------------------

  async pullNotebook(sessionId: string, _options?: PullOptions): Promise<Notebook> {
    await this.mcp.connect();
    const session = this.sessionMap.get(sessionId);
    const notebookUri = session?.notebookUri ?? sessionId;

    try {
      const result = await this.mcp.getCells({ includeOutputs: true });
      const rawCells = result.cells ?? [];

      const ipynbCells = rawCells.map((c, i) => ({
        id: String(c.id ?? c.cellId ?? c.cell_id ?? `cell-${i}`),
        cell_type: String(c.type ?? c.cell_type ?? "code"),
        source: String(c.source ?? c.code ?? c.content ?? ""),
        outputs: (c.outputs as object[] | undefined) ?? [],
        execution_count: c.executionCount ?? c.execution_count ?? null,
        metadata: {},
      }));

      const nb = deserializeNotebook({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: ipynbCells });
      nb.uri = notebookUri;
      return nb;
    } catch (err) {
      console.warn("[ColabBackend] get_cells failed:", err);
      return { uri: notebookUri, nbformat: 4, nbformatMinor: 5, metadata: { extra: {} }, cells: [] };
    }
  }

  async pushCells(sessionId: string, cells: NotebookCell[], _options?: PushOptions): Promise<Session> {
    await this.mcp.connect();
    const session = this.sessionMap.get(sessionId);
    const notebookUri = session?.notebookUri ?? sessionId;

    // Separate cells into two buckets up front:
    //   known   → already exist in Colab (use update_cell)
    //   unknown → brand-new cells (use add_code_cell / add_text_cell)
    const hasNewCells = cells.some((c) => !this.cellIdMap.has(c.id));

    // Only pay the round-trip cost of fetching the cell count when we actually
    // need to insert new cells.
    let baseIndex = 0;
    if (hasNewCells) {
      try {
        const existing = await this.mcp.getCells({});
        baseIndex = existing.cells?.length ?? 0;
        console.log(`[ColabBackend] Notebook has ${baseIndex} cell(s); new cells will be appended from index ${baseIndex}`);
      } catch (err) {
        console.warn("[ColabBackend] Could not fetch cell count before push; inserting at index 0:", err);
      }
    }

    let newCellOffset = 0; // tracks how many new cells we've inserted so far

    for (const cell of cells) {
      const existingColabId = this.cellIdMap.get(cell.id);

      if (existingColabId) {
        // ── Cell already exists in Colab → patch source in place ──────────
        try {
          await this.mcp.updateCell({ cellId: existingColabId, content: cell.source });
          console.log(`[ColabBackend] update_cell ${cell.id} → ${existingColabId}`);
        } catch (err) {
          console.warn(`[ColabBackend] update_cell failed for ${cell.id} (colabId=${existingColabId}):`, err);
        }
      } else {
        // ── New cell → append after all existing cells ─────────────────────
        const insertIndex = baseIndex + newCellOffset;
        try {
          if (cell.cellType === "markdown") {
            await this.mcp.addTextCell({ cellIndex: insertIndex, content: cell.source });
            newCellOffset++;
          } else {
            const result = await this.mcp.addCodeCell({ cellIndex: insertIndex, language: "python", code: cell.source });
            console.log(`[ColabBackend] add_code_cell result for ${cell.id}:`, JSON.stringify(result));
            newCellOffset++;

            // Extract the Colab-assigned cell ID so future edits use update_cell
            const colabCellId =
              (result as Record<string, unknown>)["cellId"] as string | undefined ??
              (result as Record<string, unknown>)["cell_id"] as string | undefined ??
              (result as Record<string, unknown>)["id"] as string | undefined;

            if (colabCellId) {
              this.persistMapping(notebookUri, cell.id, colabCellId);
              console.log(`[ColabBackend] Mapped ${cell.id} → ${colabCellId}`);
            } else {
              // Fallback: fetch the cell at the insertion index to get its Colab ID
              try {
                const fetched = await this.mcp.getCells({ cellIndexStart: insertIndex, cellIndexEnd: insertIndex });
                const fetchedId =
                  fetched.cells?.[0]?.id as string | undefined ??
                  fetched.cells?.[0]?.cellId as string | undefined ??
                  fetched.cells?.[0]?.cell_id as string | undefined;
                if (fetchedId) {
                  this.persistMapping(notebookUri, cell.id, fetchedId);
                  console.log(`[ColabBackend] Mapped (via get_cells) ${cell.id} → ${fetchedId}`);
                }
              } catch (fetchErr) {
                console.warn(`[ColabBackend] Could not fetch Colab ID for cell ${cell.id}:`, fetchErr);
              }
            }
          }
        } catch (err) {
          console.warn(`[ColabBackend] Failed to add cell ${cell.id}:`, err);
        }
      }
    }

    return session ?? this.buildSession(sessionId, sessionId);
  }

  async createNotebook(notebookPath: string): Promise<Session> {
    await this.mcp.connect();
    const sessionId = uuidv4();
    const session: Session = {
      id: sessionId,
      status: "attached",
      label: notebookPath.split("/").pop()?.replace(/\.ipynb$/, "") ?? notebookPath,
      notebookUri: notebookPath,
      backendId: this.id,
      connectedAt: new Date().toISOString(),
    };
    this.sessionMap.set(sessionId, session);
    return session;
  }

  async installPackage(sessionId: string, packageName: string): Promise<void> {
    await this.mcp.connect();
    // Add a code cell with pip install, then run it
    const result = await this.mcp.addCodeCell({
      cellIndex: 0,
      language: "python",
      code: `!pip install ${packageName}`,
    });
    const cellId = result.cellId ?? result.cell_id;
    if (cellId) {
      await this.mcp.runCodeCell({ cellId });
    }
  }

  // ---------------------------------------------------------------------------
  // Cell execution
  // ---------------------------------------------------------------------------

  async *runCells(
    sessionId: string,
    cellIds: string[],
    options?: RunCellsOptions
  ): AsyncIterable<ExecutionEvent> {
    await this.mcp.connect();
    const session = this.sessionMap.get(sessionId);
    const notebookUri = session?.notebookUri ?? sessionId;

    for (const cellId of cellIds) {
      yield makeEvent<StatusEvent>({ sessionId, cellId, kind: "status", status: "running", message: `Running cell ${cellId}` });

      // Resolve our internal ID to the Colab-assigned cell ID
      const colabCellId = this.cellIdMap.get(cellId);
      console.log(`[ColabBackend] runCells: internal=${cellId} colab=${colabCellId ?? "(none, running without id)"}`);

      try {
        const timeoutMs = options?.timeoutMs ?? 120_000;
        const result = await Promise.race([
          // If we have a Colab cell ID use it; if not, run_code_cell with no
          // cellId runs the currently selected cell (last-added by default)
          this.mcp.runCodeCell(colabCellId ? { cellId: colabCellId } : {}),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Cell ${cellId} timed out after ${timeoutMs}ms`)), timeoutMs)
          ),
        ]);

        yield* emitOutputEvents(sessionId, cellId, result.outputs ?? []);

        yield makeEvent<StatusEvent>({ sessionId, cellId, kind: "status", status: "idle", message: `Cell ${cellId} finished` });
        yield makeEvent<NotebookChangedEvent>({ sessionId, cellId, kind: "notebook_changed", notebookUri });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield makeEvent<ErrorEvent>({ sessionId, cellId, kind: "error", ename: "ExecutionError", evalue: message, traceback: [] });
        yield makeEvent<StatusEvent>({ sessionId, cellId, kind: "status", status: "error", message });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private buildSession(sessionId: string, notebookUri: string): Session {
    return { id: sessionId, status: "attached", label: notebookUri, notebookUri, backendId: this.id };
  }

  /**
   * Record a ourCellId → colabCellId mapping both in memory and on disk.
   * Pass the notebookUri so the persisted store is partitioned correctly.
   */
  private persistMapping(notebookUri: string, ourCellId: string, colabCellId: string): void {
    this.cellIdMap.set(ourCellId, colabCellId);
    if (!this.persistedMaps.has(notebookUri)) {
      this.persistedMaps.set(notebookUri, new Map());
    }
    this.persistedMaps.get(notebookUri)!.set(ourCellId, colabCellId);
    saveStore(this.persistedMaps);
  }
}

// ---------------------------------------------------------------------------
// Output event helpers
// ---------------------------------------------------------------------------

/**
 * Jupyter / nbformat stream and display payloads often use `text` as string[].
 * Using String(array) calls Array#toString(), which joins with commas — so
 * multi-chunk stdout becomes `"line1\\n,line2"` instead of `"line1\\nline2"`.
 */
function jupyterTextToString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    return value.map((part) => (typeof part === "string" ? part : String(part))).join("");
  }
  return String(value);
}

function* emitOutputEvents(
  sessionId: string,
  cellId: string,
  outputs: Array<Record<string, unknown>>
): Iterable<ExecutionEvent> {
  for (const output of outputs) {
    const outputType = String(output["outputType"] ?? output["output_type"] ?? "stream");

    if (output["text"] !== undefined) {
      const stream = output["name"] === "stderr" ? "stderr" : "stdout";
      yield makeEvent<StreamEvent>({
        sessionId,
        cellId,
        kind: "stream",
        stream,
        text: jupyterTextToString(output["text"]),
      });
    } else if (outputType === "error") {
      yield makeEvent<ErrorEvent>({
        sessionId, cellId, kind: "error",
        ename: String(output["ename"] ?? "Error"),
        evalue: jupyterTextToString(output["evalue"]),
        traceback: (output["traceback"] as string[] | undefined) ?? [],
      });
    } else if (output["data"]) {
      for (const [mimeType, data] of Object.entries(output["data"] as Record<string, unknown>)) {
        yield makeEvent<DisplayEvent>({
          sessionId, cellId, kind: "display", mimeType, data: jupyterTextToString(data),
        });
      }
    }
  }
}
