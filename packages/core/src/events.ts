/**
 * ExecutionEvent — the wire format flowing from a backend adapter through the
 * bridge service to the Cursor extension.  All variants share a common header
 * so consumers can discriminate on `kind` without boilerplate.
 */

export type ExecutionEventKind =
  | "status"
  | "stream"
  | "display"
  | "error"
  | "notebook_changed"
  | "session_changed";

interface EventBase {
  /** Unique event id — used for deduplication in unreliable transports */
  id: string;
  /** ISO-8601 timestamp */
  timestamp: string;
  /** Session the event belongs to */
  sessionId: string;
  /** Cell id if event is scoped to a single cell */
  cellId?: string;
}

export interface StatusEvent extends EventBase {
  kind: "status";
  status: "queued" | "running" | "idle" | "error";
  /** Human-readable detail line shown in the status bar */
  message?: string;
}

export interface StreamEvent extends EventBase {
  kind: "stream";
  stream: "stdout" | "stderr";
  text: string;
}

export interface DisplayEvent extends EventBase {
  kind: "display";
  mimeType: string;
  /** Raw data: plain text, HTML, or base-64 depending on mimeType */
  data: string;
  /** Incremented on successive updates to the same display (e.g. progress bars) */
  displayId?: string;
}

export interface ErrorEvent extends EventBase {
  kind: "error";
  ename: string;
  evalue: string;
  traceback: string[];
}

export interface NotebookChangedEvent extends EventBase {
  kind: "notebook_changed";
  /** The remote notebook uri that changed */
  notebookUri: string;
  /** Serialized notebook payload — only provided when a full sync is warranted */
  notebookJson?: string;
}

export interface SessionChangedEvent extends EventBase {
  kind: "session_changed";
  status: "connected" | "disconnected" | "reconnecting" | "error";
  /** Backend-specific session detail */
  detail?: string;
}

export type ExecutionEvent =
  | StatusEvent
  | StreamEvent
  | DisplayEvent
  | ErrorEvent
  | NotebookChangedEvent
  | SessionChangedEvent;

/** Narrow helper — type guard for each variant */
export function isStreamEvent(e: ExecutionEvent): e is StreamEvent {
  return e.kind === "stream";
}
export function isErrorEvent(e: ExecutionEvent): e is ErrorEvent {
  return e.kind === "error";
}
export function isNotebookChangedEvent(e: ExecutionEvent): e is NotebookChangedEvent {
  return e.kind === "notebook_changed";
}
export function isSessionChangedEvent(e: ExecutionEvent): e is SessionChangedEvent {
  return e.kind === "session_changed";
}

/** Convenience factory — callers only need to supply the variant-specific fields */
export function makeEvent<T extends ExecutionEvent>(
  partial: Omit<T, "id" | "timestamp"> & { id?: string }
): T {
  return {
    id: partial.id ?? crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...partial,
  } as T;
}
