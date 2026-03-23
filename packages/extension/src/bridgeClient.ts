/**
 * BridgeClient — talks to the local bridge HTTP service and manages the
 * WebSocket connection for streaming execution events.
 *
 * The extension imports this class and does NOT need to know the HTTP API
 * shape — all communication goes through the typed methods here.
 */

import * as vscode from "vscode";
import { WebSocket } from "ws";

export type SessionStatus =
  | "disconnected"
  | "connecting"
  | "attached"
  | "running"
  | "sync_conflict"
  | "error";

export interface SessionInfo {
  id: string;
  status: SessionStatus;
  label: string;
  notebookUri: string;
  backendId: string;
  connectedAt?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>;

export class BridgeClient implements vscode.Disposable {
  private readonly base: string;
  private ws: WebSocket | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  /** Fires every time an event arrives from the bridge over WS */
  readonly onEvent = new vscode.EventEmitter<JsonObject>();

  constructor(port: number) {
    this.base = `http://127.0.0.1:${port}`;
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  async isReachable(): Promise<boolean> {
    try {
      const res = await this.fetch("/health");
      return res.status === "ok";
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  async listSessions(backendId?: string): Promise<SessionInfo[]> {
    const qs = backendId ? `?backendId=${encodeURIComponent(backendId)}` : "";
    const { sessions } = await this.fetch(`/sessions${qs}`);
    return sessions as SessionInfo[];
  }

  async connect(
    backendId: string,
    notebookUri: string,
    existingSessionId?: string
  ): Promise<SessionInfo> {
    const { session } = await this.fetch("/sessions/connect", "POST", {
      backendId,
      notebookUri,
      existingSessionId,
    });
    return session as SessionInfo;
  }

  async disconnect(sessionId: string): Promise<void> {
    await this.fetch(`/sessions/${sessionId}/disconnect`, "POST", {});
  }

  async getSession(sessionId: string): Promise<SessionInfo | null> {
    try {
      const { session } = await this.fetch(`/sessions/${sessionId}`);
      return session as SessionInfo;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Notebook
  // ---------------------------------------------------------------------------

  async pullNotebook(sessionId: string): Promise<JsonObject> {
    const { notebook } = await this.fetch(`/sessions/${sessionId}/notebook`);
    return notebook as JsonObject;
  }

  async pushCells(
    sessionId: string,
    cells: JsonObject[],
    force = false
  ): Promise<SessionInfo> {
    const { session } = await this.fetch(
      `/sessions/${sessionId}/cells`,
      "PUT",
      { cells, options: { force } }
    );
    return session as SessionInfo;
  }

  async runCells(
    sessionId: string,
    cellIds: string[],
    options?: { clearOutputs?: boolean; timeoutMs?: number }
  ): Promise<void> {
    await this.fetch(`/sessions/${sessionId}/run`, "POST", { cellIds, options });
  }

  async createNotebook(backendId: string, path: string): Promise<SessionInfo> {
    const { session } = await this.fetch("/sessions", "POST", { backendId, path });
    return session as SessionInfo;
  }

  // ---------------------------------------------------------------------------
  // WebSocket event subscription
  // ---------------------------------------------------------------------------

  subscribeToSession(sessionId: string): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    const wsUrl = `ws://127.0.0.1:${new URL(this.base).port}/events?sessionId=${sessionId}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.on("message", (raw) => {
      try {
        const event = JSON.parse(raw.toString()) as JsonObject;
        this.onEvent.fire(event);
      } catch {
        // ignore malformed frames
      }
    });

    this.ws.on("error", (err) => {
      console.error("[BridgeClient] WS error:", err.message);
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async fetch(
    path: string,
    method: "GET" | "POST" | "PUT" = "GET",
    body?: JsonObject
  ): Promise<JsonObject> {
    const url = `${this.base}${path}`;
    const init: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    const res = await globalThis.fetch(url, init);
    const json = (await res.json()) as JsonObject;

    if (!res.ok) {
      throw new Error(
        `Bridge API error ${res.status} on ${method} ${path}: ${JSON.stringify(json)}`
      );
    }

    return json;
  }

  dispose(): void {
    this.ws?.close();
    this.onEvent.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
