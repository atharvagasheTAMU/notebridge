# Architecture

## Overview

Cursor Notebook Bridge is a monorepo consisting of four packages:

```
cursor-notebook-bridge/
├── packages/
│   ├── core/           Shared contracts, notebook model, event types, sync engine
│   ├── bridge/         Local HTTP + WebSocket service
│   ├── backend-colab/  Google Colab adapter (MCP-based)
│   └── extension/      Cursor/VS Code extension
├── docs/
└── examples/
```

## Data Flow

```
Cursor Extension
  │  (commands: run, push, pull, attach)
  ▼
BridgeClient (HTTP + WS)
  │
  ▼
Bridge Service  (http://127.0.0.1:52000)
  ├── SessionManager
  │     ├── registers backends
  │     ├── owns session lifecycle
  │     └── fan-outs ExecutionEvents to WS subscribers
  │
  ├── NotebookSyncEngine  (in-process)
  │     ├── parseScriptBlocks()     .py → ScriptBlock[]
  │     ├── scriptBlocksToNotebookCells()
  │     └── mergeNotebooks()        local + remote → SyncResult
  │
  └── Backend Adapters
        └── ColabBackend
              └── ColabMcpClient  (stdio → colab-mcp process)
                    └── Google Colab (browser tab)
```

## Package Contracts

### `@cursor-notebook-bridge/core`

All other packages depend on this. It defines:

- `NotebookBackend` interface — the only surface the bridge calls
- `NotebookSyncEngine` interface — the sync contract
- `ExecutionEvent` union — all events that flow over the WS channel
- `Notebook` / `NotebookCell` — typed `.ipynb` model
- `SyncEngine` — default implementation of `NotebookSyncEngine`
- `deserializeNotebook` / `serializeNotebook` — `.ipynb` round-trip helpers

### `@cursor-notebook-bridge/bridge`

- `SessionManager` — backend-agnostic session registry and event bus
- `server.ts` — Express HTTP + `ws` WebSocket server; entry point
- Communicates with the extension only through the typed REST/WS API

### `@cursor-notebook-bridge/backend-colab`

- `ColabMcpClient` — spawns `uvx` with a pinned `git+https://github.com/googlecolab/colab-mcp@v1.0.0` spec by default so uv reuses a cached environment; override with env `COLAB_MCP_SPEC` or setting `notebookBridge.colabMcpUvxSpec`
  and wraps each Colab MCP tool as a typed method
- `ColabBackend` — implements `NotebookBackend` using `ColabMcpClient`

### `cursor-notebook-bridge` (extension)

- `extension.ts` — activation, command registration, wiring
- `BridgeClient` — HTTP + WS client to the local bridge service
- `StatusBarItem` — status bar with session state
- `OutputPanel` — output channel with formatted event display
- `BridgeProcess` — spawns and monitors the bridge child process

## Adding a New Backend

1. Create `packages/backend-<name>/src/adapter.ts` implementing `NotebookBackend`.
2. Register it in `packages/bridge/src/server.ts`:
   ```typescript
   manager.registerBackend(new MyNewBackend());
   ```
3. No changes needed in `core`, `extension`, or other adapters.

## Session Lifecycle

```
 disconnected
     │
     │ connect()
     ▼
 connecting
     │
     │ backend resolves
     ▼
 attached ◄──────── execution complete / idle
     │
     │ runCells()
     ▼
 running
     │
     │ conflict detected on push
     ▼
 sync_conflict ──► (user force-pushes or cancels)
```

## Sync Model (v1)

- `.ipynb` is the source of truth for remote notebook state.
- Python scripts use `# %%` cell separators (VS Code convention).
- Pull and push are **explicit commands** — no auto-sync.
- Conflict detection is cell-id-based; conservative overwrite rules apply.
- Full merge/conflict UI is a post-MVP task.
