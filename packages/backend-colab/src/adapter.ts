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
  /** Maps our internal cell IDs → Colab-assigned cell IDs */
  private readonly cellIdMap = new Map<string, string>();

  constructor(mcpClient?: ColabMcpClient) {
    this.mcp = mcpClient ?? new ColabMcpClient();
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
    return session;
  }

  async disconnect(sessionId: string): Promise<void> {
    this.sessionMap.delete(sessionId);
    this.proxyConnected = false;
    this.cellIdMap.clear();
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

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]!;
      try {
        if (cell.cellType === "markdown") {
          await this.mcp.addTextCell({ cellIndex: i, content: cell.source });
        } else {
          const result = await this.mcp.addCodeCell({ cellIndex: i, language: "python", code: cell.source });
          console.log(`[ColabBackend] add_code_cell result for ${cell.id}:`, JSON.stringify(result));

          // Extract the Colab-assigned cell ID from the response
          const colabCellId =
            (result as Record<string, unknown>)["cellId"] as string | undefined ??
            (result as Record<string, unknown>)["cell_id"] as string | undefined ??
            (result as Record<string, unknown>)["id"] as string | undefined;

          if (colabCellId) {
            this.cellIdMap.set(cell.id, colabCellId);
            console.log(`[ColabBackend] Mapped ${cell.id} → ${colabCellId}`);
          } else {
            // Fallback: fetch the cell at that index to get its Colab ID
            try {
              const fetched = await this.mcp.getCells({ cellIndexStart: i, cellIndexEnd: i });
              const fetchedId =
                fetched.cells?.[0]?.id as string | undefined ??
                fetched.cells?.[0]?.cellId as string | undefined ??
                fetched.cells?.[0]?.cell_id as string | undefined;
              if (fetchedId) {
                this.cellIdMap.set(cell.id, fetchedId);
                console.log(`[ColabBackend] Mapped (via get_cells) ${cell.id} → ${fetchedId}`);
              }
            } catch (fetchErr) {
              console.warn(`[ColabBackend] Could not fetch Colab ID for cell ${cell.id}:`, fetchErr);
            }
          }
        }
      } catch (err) {
        console.warn(`[ColabBackend] Failed to push cell ${cell.id}:`, err);
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
}

// ---------------------------------------------------------------------------
// Output event helpers
// ---------------------------------------------------------------------------

function* emitOutputEvents(
  sessionId: string,
  cellId: string,
  outputs: Array<Record<string, unknown>>
): Iterable<ExecutionEvent> {
  for (const output of outputs) {
    const outputType = String(output["outputType"] ?? output["output_type"] ?? "stream");

    if (output["text"] !== undefined) {
      yield makeEvent<StreamEvent>({ sessionId, cellId, kind: "stream", stream: "stdout", text: String(output["text"]) });
    } else if (outputType === "error") {
      yield makeEvent<ErrorEvent>({
        sessionId, cellId, kind: "error",
        ename: String(output["ename"] ?? "Error"),
        evalue: String(output["evalue"] ?? ""),
        traceback: (output["traceback"] as string[] | undefined) ?? [],
      });
    } else if (output["data"]) {
      for (const [mimeType, data] of Object.entries(output["data"] as Record<string, unknown>)) {
        yield makeEvent<DisplayEvent>({ sessionId, cellId, kind: "display", mimeType, data: String(data) });
      }
    }
  }
}
