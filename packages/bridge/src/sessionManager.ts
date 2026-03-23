/**
 * SessionManager — owns the lifecycle of all active notebook sessions.
 *
 * The extension talks to the bridge HTTP/WS server; the server delegates
 * to this manager which in turn calls the appropriate NotebookBackend adapter.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  NotebookBackend,
  Session,
  SessionStatus,
  RunCellsOptions,
  PushOptions,
  PullOptions,
} from "@cursor-notebook-bridge/core";
import type { ExecutionEvent } from "@cursor-notebook-bridge/core";
import type { NotebookCell } from "@cursor-notebook-bridge/core";
import type { Notebook } from "@cursor-notebook-bridge/core";

export type EventListener = (event: ExecutionEvent) => void;

export class SessionManager {
  private readonly backends = new Map<string, NotebookBackend>();
  private readonly sessions = new Map<string, Session>();
  private readonly eventListeners = new Map<string, Set<EventListener>>();

  // ---------------------------------------------------------------------------
  // Backend registration
  // ---------------------------------------------------------------------------

  registerBackend(backend: NotebookBackend): void {
    if (this.backends.has(backend.id)) {
      throw new Error(`Backend "${backend.id}" is already registered.`);
    }
    this.backends.set(backend.id, backend);
    console.log(`[SessionManager] Registered backend: ${backend.displayName}`);
  }

  listBackends(): Array<{ id: string; displayName: string }> {
    return Array.from(this.backends.values()).map((b) => ({
      id: b.id,
      displayName: b.displayName,
    }));
  }

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  async listSessions(backendId?: string): Promise<Session[]> {
    if (backendId) {
      const backend = this.requireBackend(backendId);
      const remote = await backend.listSessions();
      for (const s of remote) this.sessions.set(s.id, s);
      return remote;
    }
    return Array.from(this.sessions.values());
  }

  async connect(
    backendId: string,
    notebookUri: string,
    existingSessionId?: string
  ): Promise<Session> {
    const backend = this.requireBackend(backendId);
    const session = await backend.connect(notebookUri, existingSessionId);
    this.sessions.set(session.id, session);
    this.emitSessionChanged(session.id, "connected");
    return session;
  }

  async disconnect(sessionId: string): Promise<void> {
    const { backend, session } = this.requireSession(sessionId);
    await backend.disconnect(session.id);
    this.updateStatus(sessionId, "disconnected");
    this.emitSessionChanged(sessionId, "disconnected");
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Notebook operations
  // ---------------------------------------------------------------------------

  async pullNotebook(sessionId: string, options?: PullOptions): Promise<Notebook> {
    const { backend } = this.requireSession(sessionId);
    return backend.pullNotebook(sessionId, options);
  }

  async pushCells(
    sessionId: string,
    cells: NotebookCell[],
    options?: PushOptions
  ): Promise<Session> {
    const { backend } = this.requireSession(sessionId);
    const updated = await backend.pushCells(sessionId, cells, options);
    this.sessions.set(updated.id, updated);
    return updated;
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  async runCells(
    sessionId: string,
    cellIds: string[],
    options?: RunCellsOptions
  ): Promise<void> {
    const { backend } = this.requireSession(sessionId);
    this.updateStatus(sessionId, "running");

    try {
      for await (const event of backend.runCells(sessionId, cellIds, options)) {
        this.broadcast(sessionId, event);
      }
    } finally {
      this.updateStatus(sessionId, "attached");
    }
  }

  async createNotebook(backendId: string, path: string): Promise<Session> {
    const backend = this.requireBackend(backendId);
    const session = await backend.createNotebook(path);
    this.sessions.set(session.id, session);
    return session;
  }

  async installPackage(sessionId: string, packageName: string): Promise<void> {
    const { backend } = this.requireSession(sessionId);
    await backend.installPackage(sessionId, packageName);
  }

  // ---------------------------------------------------------------------------
  // Event bus
  // ---------------------------------------------------------------------------

  subscribe(sessionId: string, listener: EventListener): () => void {
    if (!this.eventListeners.has(sessionId)) {
      this.eventListeners.set(sessionId, new Set());
    }
    this.eventListeners.get(sessionId)!.add(listener);
    return () => this.eventListeners.get(sessionId)?.delete(listener);
  }

  private broadcast(sessionId: string, event: ExecutionEvent): void {
    const listeners = this.eventListeners.get(sessionId);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[SessionManager] Event listener threw:", err);
      }
    }
  }

  private emitSessionChanged(
    sessionId: string,
    status: "connected" | "disconnected" | "reconnecting" | "error"
  ): void {
    this.broadcast(sessionId, {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      sessionId,
      kind: "session_changed",
      status,
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private requireBackend(backendId: string): NotebookBackend {
    const backend = this.backends.get(backendId);
    if (!backend) {
      throw new Error(
        `No backend registered with id "${backendId}". ` +
          `Available: ${Array.from(this.backends.keys()).join(", ")}`
      );
    }
    return backend;
  }

  private requireSession(sessionId: string): {
    backend: NotebookBackend;
    session: Session;
  } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session "${sessionId}" not found.`);
    }
    const backend = this.requireBackend(session.backendId);
    return { backend, session };
  }

  private updateStatus(sessionId: string, status: SessionStatus): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.sessions.set(sessionId, { ...session, status });
    }
  }
}
