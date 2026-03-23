/**
 * NotebookBackend — the interface every backend adapter must implement.
 *
 * The bridge service talks exclusively through this interface, which means
 * adding a new backend (Kaggle, JupyterHub, local Jupyter) only requires a
 * new class that satisfies this contract — no changes to bridge or extension.
 */

import type { ExecutionEvent } from "./events.js";
import type { Notebook, NotebookCell } from "./notebookModel.js";

// ---------------------------------------------------------------------------
// Session model
// ---------------------------------------------------------------------------

export type SessionStatus =
  | "disconnected"
  | "connecting"
  | "attached"
  | "running"
  | "sync_conflict"
  | "error";

export interface Session {
  id: string;
  status: SessionStatus;
  /** Human-readable label shown in the status bar */
  label: string;
  /** URI of the notebook this session is attached to */
  notebookUri: string;
  /** Backend that owns this session */
  backendId: string;
  connectedAt?: string;
}

// ---------------------------------------------------------------------------
// Backend capabilities declaration
// ---------------------------------------------------------------------------

export interface BackendCapabilities {
  /** Backend can stream output as cells execute (vs only returning on completion) */
  supportsStreamingOutput: boolean;
  /** Backend can create and reorder cells programmatically */
  supportsNotebookStructureEdit: boolean;
  /** Backend exposes rich display outputs (images, HTML, etc.) */
  supportsRichOutput: boolean;
  /** Backend requires a browser session to be open for auth */
  requiresBrowserSession: boolean;
}

// ---------------------------------------------------------------------------
// Run options
// ---------------------------------------------------------------------------

export interface RunCellsOptions {
  /** If true, clear all outputs before running */
  clearOutputs?: boolean;
  /** Milliseconds before the bridge gives up waiting for a result */
  timeoutMs?: number;
}

export interface PushOptions {
  /** If true, overwrite remote cells even if remote has newer changes */
  force?: boolean;
}

export interface PullOptions {
  /** If true, overwrite local notebook even if local has uncommitted changes */
  force?: boolean;
}

// ---------------------------------------------------------------------------
// The backend interface
// ---------------------------------------------------------------------------

export interface NotebookBackend {
  /** Unique stable identifier, e.g. "colab", "jupyter", "kaggle" */
  readonly id: string;
  /** Human-readable name shown in the session picker */
  readonly displayName: string;

  readonly capabilities: BackendCapabilities;

  /**
   * Enumerate available sessions (open notebooks, running runtimes, etc.)
   * Returns an empty array if no sessions are currently active.
   */
  listSessions(): Promise<Session[]>;

  /**
   * Attach to an existing session by id, or create a new one for the given
   * notebook URI.  Must resolve before any cells can be executed.
   */
  connect(notebookUri: string, existingSessionId?: string): Promise<Session>;

  /**
   * Gracefully detach from a session.  Does NOT terminate the remote runtime.
   */
  disconnect(sessionId: string): Promise<void>;

  /**
   * Fetch the full current notebook state from the remote backend.
   */
  pullNotebook(sessionId: string, options?: PullOptions): Promise<Notebook>;

  /**
   * Replace the remote notebook cells with the provided set.
   * Returns the updated session state.
   */
  pushCells(
    sessionId: string,
    cells: NotebookCell[],
    options?: PushOptions
  ): Promise<Session>;

  /**
   * Execute one or more cells in the remote runtime.
   * Returns an async iterable of ExecutionEvents so the bridge can stream
   * them to the extension in real time.
   */
  runCells(
    sessionId: string,
    cellIds: string[],
    options?: RunCellsOptions
  ): AsyncIterable<ExecutionEvent>;

  /**
   * Create a new empty notebook at the given path/URI on the backend.
   * Returns the session representing the new notebook.
   */
  createNotebook(path: string): Promise<Session>;

  /**
   * Install a package in the runtime attached to sessionId.
   * Convenience wrapper used by agents/tooling; equivalent to running
   * a cell with `!pip install <packageName>`.
   */
  installPackage(sessionId: string, packageName: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// NotebookSyncEngine — owned by the bridge, not by individual backends.
// ---------------------------------------------------------------------------

export interface ScriptBlock {
  /** Content of the code block */
  source: string;
  /** 0-based start line in the source file */
  startLine: number;
  /** 0-based end line in the source file */
  endLine: number;
  /** Resolved cell type — defaults to "code" */
  cellType: "code" | "markdown";
  /**
   * If a `# %%` or `# %% [markdown]` magic comment was present, its content.
   * Used to preserve author-written cell separators on round-trips.
   */
  separator?: string;
}

export interface SyncResult {
  merged: boolean;
  /** Cells that were added on the remote side since last sync */
  newRemoteCells: NotebookCell[];
  /** Cells that were modified locally but also remotely (conflict candidates) */
  conflictCells: string[];
  /** Final merged notebook — not written anywhere; caller decides persistence */
  notebook: Notebook;
}

export interface NotebookSyncEngine {
  /**
   * Parse a Python (or R/Julia) script into ScriptBlocks using `# %%` cell
   * separator comments.  Falls back to treating the whole file as one block.
   */
  parseScriptBlocks(scriptSource: string): ScriptBlock[];

  /**
   * Map a list of script blocks onto NotebookCells, preserving existing cell
   * ids where source content matches.
   */
  scriptBlocksToNotebookCells(
    blocks: ScriptBlock[],
    existingCells: NotebookCell[]
  ): NotebookCell[];

  /**
   * Merge a locally edited notebook with a freshly pulled remote notebook.
   * Uses conservative "last-write-wins at cell level" semantics for v1.
   */
  mergeNotebooks(local: Notebook, remote: Notebook): SyncResult;
}
