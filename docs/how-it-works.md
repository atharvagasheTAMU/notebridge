# How It Works — Detailed Walkthrough

## The Big Picture

The project is a monorepo with four packages that form a chain:

```
Cursor (you write code here)
    ↓ HTTP commands
Local Bridge Service  (runs on your machine, port 52000)
    ↓ MCP over stdio
Colab MCP Server  (spawned automatically)
    ↓ browser protocol
Google Colab  (open in Chrome)
```

Events flow back in reverse — cell outputs stream from Colab → MCP server → bridge → WebSocket → your Cursor output panel.

---

## Package 1: `packages/core` — The Contract Layer

This is the foundation. Every other package imports from here and nothing else. This is intentional: it means you can swap out any backend without touching the extension or the bridge.

### `notebookModel.ts`

Defines typed versions of the `.ipynb` JSON format. A raw notebook file is just a blob of JSON — this file gives it a proper shape:

```typescript
interface NotebookCell {
  id: string;
  cellType: "code" | "markdown" | "raw";
  source: string;
  outputs: CellOutput[];
  executionCount: number | null;
  metadata: Record<string, unknown>;
}
```

It also includes `deserializeNotebook` and `serializeNotebook` — functions that convert between the raw `.ipynb` JSON and this typed model. Every time the bridge pulls a notebook from Colab or saves one locally, it goes through these functions.

### `events.ts`

Defines every kind of message that flows from the backend to your editor:

| Event kind | When it fires |
|---|---|
| `stream` | A cell printed something to stdout/stderr |
| `display` | A cell produced a plot, image, or HTML |
| `error` | A cell threw an exception |
| `status` | Execution state changed (queued/running/idle/error) |
| `notebook_changed` | The remote notebook state changed |
| `session_changed` | Connection dropped or reconnected |

### `contracts.ts`

This is the most important file in the entire project. It defines the `NotebookBackend` interface — the only thing any backend (Colab, Kaggle, local Jupyter) must implement:

```typescript
interface NotebookBackend {
  connect(notebookUri: string): Promise<Session>;
  listSessions(): Promise<Session[]>;
  pullNotebook(sessionId: string): Promise<Notebook>;
  pushCells(sessionId: string, cells: NotebookCell[]): Promise<Session>;
  runCells(sessionId: string, cellIds: string[]): AsyncIterable<ExecutionEvent>;
  createNotebook(path: string): Promise<Session>;
  installPackage(sessionId: string, packageName: string): Promise<void>;
  disconnect(sessionId: string): Promise<void>;
}
```

Adding a new backend later only means implementing this one interface. The bridge and extension never change.

### `syncEngine.ts`

Handles the notebook sync logic. Two key capabilities:

1. **Parse `# %%` script blocks** — so you can work in a `.py` file instead of a notebook. The comments like `# %%`, `# %% [markdown]`, `# %% Import data` are the VS Code convention for cell separators. The engine splits your script at these markers and maps each block to a notebook cell.

2. **Merge local and remote notebooks** — when you pull from Colab after running cells, the engine reconciles your local edits with the remote outputs. The v1 strategy is conservative: if both sides have cells the other doesn't, it flags a conflict instead of guessing. If only the remote has new cells (e.g. the agent added cells), it accepts them.

---

## Package 2: `packages/bridge` — The Local Service

This is a small Node.js process that the extension starts automatically. It runs at `http://127.0.0.1:52000`.

### `sessionManager.ts`

The central coordinator. It:
- Keeps a registry of all `NotebookBackend` instances (one per backend type)
- Tracks all active sessions (open notebooks)
- Routes commands to the correct backend
- Runs an event bus: when a backend emits an `ExecutionEvent`, the manager fans it out to all WebSocket subscribers for that session

When you add a new backend, you call `manager.registerBackend(new MyBackend())` here. That is the only change needed in the bridge.

### `server.ts`

An Express HTTP server plus a WebSocket server, both running on the same port.

The REST API:

```
GET  /sessions              → list sessions
POST /sessions/connect      → attach to a notebook
GET  /sessions/:id/notebook → pull notebook state
PUT  /sessions/:id/cells    → push cells
POST /sessions/:id/run      → trigger cell execution
POST /sessions/:id/install  → install a package
GET  /health                → ping
```

The WebSocket at `/events?sessionId=<id>` streams all `ExecutionEvent` objects as JSON in real time. The extension connects to this socket as soon as a session is attached, so execution output appears immediately in the output panel.

Why HTTP + WebSocket rather than just one of them? HTTP is used for commands (request/response) and WebSocket is used for the event stream (push). Mixing them would require either polling (slow) or streaming every response (complex). Keeping them separate is the cleaner design.

---

## Package 3: `packages/backend-colab` — The Colab Adapter

This is the only Colab-specific code in the entire project. If Colab changes their API, only this package changes.

### `mcpClient.ts`

The Colab MCP server (released by Google on March 17, 2026) is a command-line tool the bridge starts with `uvx` using a pinned git tag on `googlecolab/colab-mcp` so installs are cached. Override with environment variable `COLAB_MCP_SPEC` or VS Code setting `notebookBridge.colabMcpUvxSpec` if you need `main` or another ref. It speaks the [Model Context Protocol](https://modelcontextprotocol.io/) over stdio — the same protocol Cursor uses internally.

This file spawns that process and wraps each of its tools as a typed method:

```typescript
class ColabMcpClient {
  async listNotebooks(): Promise<{notebooks: [{id, title, url}]}>
  async createNotebook(args): Promise<{notebookId, url}>
  async getNotebook(args): Promise<{raw: ipynb_json}>
  async addCell(args): Promise<{cellId}>
  async updateCell(args): Promise<void>
  async runCell(args): Promise<{outputs: [...]}>
  // etc.
}
```

The MCP server requires a Colab tab to be open in Chrome — that is how auth works. You are already logged into Google in your browser, and the MCP server communicates with that tab. No API keys, no OAuth flow.

### `adapter.ts`

Implements the `NotebookBackend` interface using `ColabMcpClient`. This is the translation layer — it converts the bridge's generic operations into specific MCP tool calls.

For example, `pushCells()` has to:
1. Pull the current remote notebook to see what is there
2. Delete any cells that no longer exist locally
3. Add new cells at the right index
4. Update existing cells' source

And `runCells()` returns an `AsyncIterable<ExecutionEvent>` — it calls `mcp.runCell()` for each cell, then converts the output objects (stream text, display data, errors) into the typed event format the bridge understands.

---

## Package 4: `packages/extension` — The Cursor Extension

This is the part you actually interact with in the editor.

### `bridgeProcess.ts`

When you activate the extension (by running any `Notebook Bridge:` command), it spawns the bridge server as a child Node.js process. It watches for a `{"ready": true, "port": 52000}` JSON line on stdout before considering the bridge available. If the bridge does not start within 15 seconds, it shows an error.

### `bridgeClient.ts`

The HTTP and WebSocket client that talks to the bridge service. Every command the extension runs goes through here — it never calls Colab APIs directly.

### `statusBar.ts`

The status bar item in the bottom-left of Cursor. It always shows the current session state with appropriate icons and colors:

| State | Display |
|---|---|
| disconnected | `⊗ No Session` |
| connecting | `⟳ Connecting…` |
| attached | `⚡ Attached · My Notebook` |
| running | `⟳ Running…` |
| sync_conflict | `⚠ Sync Conflict` |
| error | `✗ Bridge Error` |

### `outputPanel.ts`

A VS Code output channel named "Notebook Bridge". It receives every `ExecutionEvent` from the WebSocket and formats it for display: plain text for `stream` events, error messages with traceback for `error` events, and placeholder lines for images/HTML that are not renderable in a text panel.

### Commands (`commands/` folder)

**`attachSession.ts`**
Shows an input box asking for a Colab URL. Checks if a session for that URL already exists and offers to reuse it. Connects via the bridge. Subscribes to the WebSocket event stream.

**`runSelection.ts`**
Triggered by `Ctrl+Shift+Enter` when you have Python code selected. Takes the selected text (or the whole file if nothing is selected), pushes it as a single code cell, then calls `runCells`. Output streams back through the WebSocket to the output panel in real time.

**`syncNotebook.ts`**
Two commands:
- **Pull**: Fetches the current `.ipynb` from the remote session and opens a Save dialog so you can write it to disk. Then opens it in the notebook editor.
- **Push**: Reads the current file (`.ipynb` or `.py`), shows a confirmation dialog, calls `pushCells`. If the remote has conflicting changes, it asks whether to force-push.

---

## The Sync Model in Detail

When you push a `.py` script, the flow is:

```
foo.py  →  parseScriptBlocks()  →  ScriptBlock[]
              ↓
         scriptBlocksToNotebookCells()  ←  existing cells (for id reuse)
              ↓
         NotebookCell[]  →  bridge  →  ColabBackend.pushCells()
```

The `# %%` separator marks the boundary between cells. The engine tries to match blocks to existing cells by source content, so if you only changed one block, only that cell gets a new id — the rest keep their ids and thus keep their remote execution outputs.

When you pull after running:

```
remote notebook  →  mergeNotebooks(local, remote)  →  SyncResult
```

Merge rules:

| Scenario | Result |
|---|---|
| Remote has cells local does not (agent added them) | Accepted, appended to local copy |
| Local has cells remote does not (not yet pushed) | Kept as-is |
| Both sides have cells the other does not (genuine divergence) | Flagged as `sync_conflict` — no automatic merge, user chooses force-push or cancel |

---

## How To Actually Use It

1. Make sure you have Python, `uv` (`pip install uv`), and Node.js installed
2. Open a Colab notebook in Chrome (any notebook — the MCP server attaches to it)
3. In Cursor: press `F5` on `packages/extension` to launch an Extension Development Host, or package the `.vsix` file with `pnpm package`
4. Open a `.py` file or a `.ipynb` file
5. `Ctrl+Shift+P` → **"Notebook Bridge: Attach to Session"** → paste your Colab URL
6. Select some Python code → `Ctrl+Shift+Enter` → watch it run on Colab's hardware
7. `Ctrl+Shift+P` → **"Notebook Bridge: Pull Notebook from Remote"** → save the `.ipynb` artifact
