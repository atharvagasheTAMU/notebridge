/**
 * Bridge HTTP + WebSocket server.
 *
 * The Cursor extension starts this process as a child process and communicates
 * via:
 *   - REST  → session management, notebook push/pull, run-cells trigger
 *   - WS    → streaming execution events back to the extension in real time
 *
 * Default port: 52000 (configurable via BRIDGE_PORT env var).
 */

import http from "http";
import express, { Request, Response, NextFunction } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { SessionManager } from "./sessionManager.js";
import { ColabBackend } from "@cursor-notebook-bridge/backend-colab";
import type { NotebookCell } from "@cursor-notebook-bridge/core";

const PORT = Number(process.env["BRIDGE_PORT"] ?? 52000);

const manager = new SessionManager();

// Register all available backends
manager.registerBackend(new ColabBackend());

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "10mb" }));

// ------ Backends ------

app.get("/backends", (_req: Request, res: Response) => {
  res.json({ backends: manager.listBackends() });
});

// ------ Sessions ------

app.get("/sessions", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { backendId } = req.query as { backendId?: string };
    const sessions = await manager.listSessions(backendId);
    res.json({ sessions });
  } catch (err) {
    next(err);
  }
});

app.post("/sessions/connect", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { backendId, notebookUri, existingSessionId } = req.body as {
      backendId: string;
      notebookUri: string;
      existingSessionId?: string;
    };
    const session = await manager.connect(backendId, notebookUri, existingSessionId);
    res.json({ session });
  } catch (err) {
    next(err);
  }
});

app.post("/sessions/:sessionId/disconnect", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await manager.disconnect(req.params["sessionId"]!);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get("/sessions/:sessionId", (req: Request, res: Response) => {
  const session = manager.getSession(req.params["sessionId"]!);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json({ session });
});

// ------ Notebooks ------

app.get("/sessions/:sessionId/notebook", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const notebook = await manager.pullNotebook(req.params["sessionId"]!);
    res.json({ notebook });
  } catch (err) {
    next(err);
  }
});

app.put("/sessions/:sessionId/cells", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cells, options } = req.body as {
      cells: NotebookCell[];
      options?: { force?: boolean };
    };
    const session = await manager.pushCells(req.params["sessionId"]!, cells, options);
    res.json({ session });
  } catch (err) {
    next(err);
  }
});

app.post("/sessions/:sessionId/run", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { cellIds, options } = req.body as {
      cellIds: string[];
      options?: { clearOutputs?: boolean; timeoutMs?: number };
    };
    // Run is async — events come back over WS; we just acknowledge the request here.
    manager
      .runCells(req.params["sessionId"]!, cellIds, options)
      .catch((err: unknown) =>
        console.error("[server] run error for session", req.params["sessionId"], err)
      );
    res.json({ ok: true, message: "Execution started. Subscribe to WS for events." });
  } catch (err) {
    next(err);
  }
});

app.post("/sessions", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { backendId, path } = req.body as { backendId: string; path: string };
    const session = await manager.createNotebook(backendId, path);
    res.json({ session });
  } catch (err) {
    next(err);
  }
});

app.post("/sessions/:sessionId/install", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { packageName } = req.body as { packageName: string };
    await manager.installPackage(req.params["sessionId"]!, packageName);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ------ Health ------

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", pid: process.pid, uptime: process.uptime() });
});

// ------ Error handler ------

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[bridge]", message);
  res.status(500).json({ error: message });
});

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/events" });

wss.on("connection", (ws: WebSocket, req) => {
  const url = new URL(req.url ?? "", `http://localhost`);
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    ws.close(1008, "sessionId query param required");
    return;
  }

  console.log(`[WS] Client subscribed to session ${sessionId}`);

  const unsubscribe = manager.subscribe(sessionId, (event) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  });

  ws.on("close", () => {
    console.log(`[WS] Client unsubscribed from session ${sessionId}`);
    unsubscribe();
  });

  ws.on("error", (err) => {
    console.error(`[WS] Error on session ${sessionId}:`, err.message);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`[bridge] Listening on http://127.0.0.1:${PORT}`);
  // Signal the extension that the bridge is ready
  process.stdout.write(
    JSON.stringify({ ready: true, port: PORT }) + "\n"
  );
});

export { manager };
