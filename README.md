# Cursor Notebook Bridge

> Edit in Cursor. Execute on cloud hardware. Keep a live notebook artifact.

**Cursor Notebook Bridge** is an open-source Cursor/VS Code extension that connects your local editor to remote notebook runtimes — starting with Google Colab and designed to support any `ipynb`-compatible backend.

---

## Why This Exists

When you work with AI-assisted code generation in Cursor, you often hit a wall: the code is great, but running it locally is slow, or you need a GPU, or you want a reproducible `.ipynb` artifact to share with others. Copy-pasting code into Colab kills flow.

This project removes that friction. You write and edit in Cursor; the bridge runs your code on Colab (or any Jupyter-compatible backend) and streams results back in real time.

---

## Features (MVP)

- **Attach to Notebook Session** — connect to an open Colab notebook or create a new one
- **Run Selection on Remote** — `Ctrl+Shift+Enter` runs the selected block or whole file
- **Push/Pull Notebook** — sync `.ipynb` state between Cursor and the remote
- **Streaming output** — logs, errors, and rich outputs appear in the Output panel
- **Status bar** — always shows session state (disconnected → attached → running)
- **Backend-agnostic** — adding Kaggle, JupyterHub, or local Jupyter is a single adapter file

---

## Getting Started

### Option A — Automated setup (recommended)

The setup scripts check for every prerequisite, install anything missing, and
build all packages in one step. They also permanently add the required
directories to your system PATH so the Cursor extension host can find `git`
and `uv` at runtime.

**Windows** (run PowerShell as Administrator):
```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\setup.ps1
```

**macOS / Linux**:
```bash
bash scripts/setup.sh
```

After the script finishes, **close and reopen Cursor** so the updated PATH
takes effect, then press **F5** to launch the Extension Development Host.

### Option B — Manual setup

| Requirement | Notes |
|-------------|-------|
| Git | Must be on the system PATH (not just user PATH) |
| Node.js ≥ 18 | For the bridge service |
| pnpm ≥ 9 | `npm install -g pnpm` |
| Python 3.9+ | For the Colab MCP server |
| uv | `pip install uv` |
| Google Chrome with Colab tab open | Auth uses your existing Google session |

```bash
# Clone and build
git clone https://github.com/cursor-notebook-bridge/cursor-notebook-bridge
cd cursor-notebook-bridge
pnpm install
pnpm build

# Open a Colab notebook in Chrome, then press F5 in Cursor
# Cmd/Ctrl+Shift+P → "Notebook Bridge: Attach to Session"
# Paste your Colab URL → Ctrl+Shift+Enter to run selected code
```

---

## Repo Layout

```
packages/
  core/            Contracts, notebook model, events, sync engine
  bridge/          Local HTTP + WebSocket service
  backend-colab/   Google Colab adapter (Colab MCP protocol)
  extension/       Cursor/VS Code extension
docs/
  architecture.md  System design and component diagram
  colab-spike.md   Colab MCP validation findings
examples/
  hello_colab.py   Example script with # %% cell separators
```

---

## How It Works

```
Cursor Extension
    │ REST / WebSocket
    ▼
Local Bridge (port 52000)
    │
    ├── SessionManager
    ├── NotebookSyncEngine
    │
    └── ColabBackend
          │ MCP over stdio
          ▼
       colab-mcp server  ──→  Colab browser tab
```

Full details: [docs/architecture.md](docs/architecture.md)

---

## Adding a New Backend

The `NotebookBackend` interface in `packages/core/src/contracts.ts` is the only contract you need to implement:

```typescript
class MyBackend implements NotebookBackend {
  readonly id = "my-backend";
  readonly displayName = "My Jupyter Server";
  // ... implement connect, pullNotebook, pushCells, runCells, etc.
}
```

Register it in `packages/bridge/src/server.ts` and you're done. No other packages change.

---

## Development

```bash
# Typecheck all packages
pnpm typecheck

# Build
pnpm build

# Launch extension in Cursor's Extension Development Host
# Open packages/extension in Cursor → F5
```

---

## Roadmap

- [x] Core contracts and notebook model
- [x] Local bridge service (HTTP + WebSocket)
- [x] Colab backend via official MCP server
- [x] Cursor extension with run/push/pull commands
- [x] Script-to-notebook sync engine (`# %%` separator support)
- [ ] Validate Colab MCP tool names against live server (see `docs/colab-spike.md`)
- [ ] Streaming output support (upgrade `supportsStreamingOutput` once confirmed)
- [ ] Kaggle backend adapter
- [ ] Local Jupyter backend adapter
- [ ] Notebook diff viewer in Cursor
- [ ] Multi-session management panel

---

## Contributing

Issues and PRs welcome. Please read [docs/architecture.md](docs/architecture.md) first to understand the design boundaries.

---

## License

MIT
