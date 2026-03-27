/**
 * RichOutputPanel — a VS Code webview panel that renders rich cell outputs
 * (images, HTML, JSON) that cannot be shown in a plain text OutputChannel.
 *
 * The panel opens automatically the first time a display event with a
 * renderable MIME type arrives.  It stays alive in the background between
 * runs (retainContextWhenHidden = true) so the previous plot is still visible
 * while you edit code.
 *
 * Supported MIME types:
 *   image/*              → <img> tag with base64 data URI
 *   text/html            → safe innerHTML inside a sandboxed div
 *   application/json     → pretty-printed <pre> block
 *   text/plain           → <pre> block (only when emitted as a display event)
 */

import * as vscode from "vscode";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>;

const RENDERABLE = new Set([
  "text/html",
  "application/json",
  "text/plain",
  "text/latex",
]);

function isRenderable(mimeType: string): boolean {
  return mimeType.startsWith("image/") || RENDERABLE.has(mimeType);
}

export class RichOutputPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Feed an ExecutionEvent into the panel.
   * Only `display` events with renderable MIME types produce visible output.
   * Returns true if the event was handled (so OutputPanel can skip it).
   */
  handleEvent(event: JsonObject): boolean {
    if (event["kind"] !== "display") return false;

    const mimeType = String(event["mimeType"] ?? "");
    if (!isRenderable(mimeType)) return false;

    this.ensurePanel();
    this.panel!.webview.postMessage({
      type: "add_output",
      cellId: String(event["cellId"] ?? ""),
      mimeType,
      data: String(event["data"] ?? ""),
    });

    // Reveal beside the editor without stealing focus
    this.panel!.reveal(vscode.ViewColumn.Two, /* preserveFocus */ true);
    return true;
  }

  /** Clear all outputs — call at the start of each new run. */
  clear(): void {
    this.panel?.webview.postMessage({ type: "clear" });
  }

  show(): void {
    this.ensurePanel();
    this.panel!.reveal(vscode.ViewColumn.Two, false);
  }

  private ensurePanel(): void {
    if (this.panel) return;

    this.panel = vscode.window.createWebviewPanel(
      "notebookBridgeRichOutput",
      "Notebook Output",
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        // No local resource roots — all content is inlined
      }
    );

    this.panel.webview.html = buildHtml();
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    // Handle "clear" button messages from the webview
    this.panel.webview.onDidReceiveMessage((msg: JsonObject) => {
      if (msg["type"] === "clear") {
        this.panel?.webview.postMessage({ type: "clear" });
      }
    });
  }

  dispose(): void {
    this.panel?.dispose();
  }
}

// ---------------------------------------------------------------------------
// Webview HTML — fully self-contained, no external URIs
// ---------------------------------------------------------------------------

function buildHtml(): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
  <title>Notebook Output</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family, 'Segoe UI', system-ui, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground, #cdd6f4);
      background: var(--vscode-editor-background, #1e1e2e);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* ── Header ─────────────────────────────────────────────────────────── */
    #header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 14px;
      background: var(--vscode-editorGroupHeader-tabsBackground, #181825);
      border-bottom: 1px solid var(--vscode-editorGroup-border, #313244);
      flex-shrink: 0;
    }

    #header .title {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--vscode-foreground, #cdd6f4);
      opacity: 0.7;
    }

    #header .actions {
      display: flex;
      gap: 6px;
    }

    button {
      background: transparent;
      border: 1px solid var(--vscode-button-border, #45475a);
      color: var(--vscode-button-secondaryForeground, #cdd6f4);
      padding: 3px 10px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
      line-height: 1.6;
      transition: background 0.12s, border-color 0.12s;
    }

    button:hover {
      background: var(--vscode-button-secondaryHoverBackground, #313244);
      border-color: var(--vscode-focusBorder, #89b4fa);
    }

    /* ── Scroll area ─────────────────────────────────────────────────────── */
    #scroll {
      flex: 1;
      overflow-y: auto;
      padding: 12px 14px 24px;
    }

    /* ── Placeholder ─────────────────────────────────────────────────────── */
    #placeholder {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 10px;
      opacity: 0.4;
    }

    #placeholder svg { width: 40px; height: 40px; }

    #placeholder p {
      font-size: 12px;
      text-align: center;
      max-width: 220px;
      line-height: 1.5;
    }

    /* ── Output cards ────────────────────────────────────────────────────── */
    .output-card {
      background: var(--vscode-editor-inactiveSelectionBackground, #313244);
      border: 1px solid var(--vscode-editorGroup-border, #45475a);
      border-radius: 6px;
      margin-bottom: 10px;
      overflow: hidden;
    }

    .cell-label {
      font-size: 10px;
      font-family: var(--vscode-editor-font-family, 'Cascadia Code', monospace);
      color: var(--vscode-descriptionForeground, #6c7086);
      padding: 4px 10px;
      border-bottom: 1px solid var(--vscode-editorGroup-border, #45475a);
      background: var(--vscode-editorGroupHeader-tabsBackground, #181825);
      letter-spacing: 0.03em;
    }

    .output-content {
      padding: 10px;
    }

    /* Images */
    .output-image {
      max-width: 100%;
      height: auto;
      display: block;
      border-radius: 3px;
    }

    /* HTML outputs (DataFrames, custom HTML) */
    .output-html {
      overflow-x: auto;
      font-size: 12px;
      line-height: 1.5;
    }

    /* Style injected HTML tables (pandas DataFrames, etc.) */
    .output-html table {
      border-collapse: collapse;
      width: max-content;
      min-width: 100%;
    }

    .output-html th, .output-html td {
      border: 1px solid var(--vscode-editorGroup-border, #45475a);
      padding: 4px 10px;
      font-size: 12px;
      text-align: right;
    }

    .output-html th {
      background: var(--vscode-editorGroupHeader-tabsBackground, #181825);
      font-weight: 600;
      text-align: center;
    }

    .output-html tr:nth-child(even) td {
      background: rgba(255,255,255,0.03);
    }

    /* Plain text / LaTeX */
    .output-pre {
      font-family: var(--vscode-editor-font-family, 'Cascadia Code', monospace);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-all;
      line-height: 1.55;
      color: var(--vscode-terminal-foreground, #cdd6f4);
    }

    /* JSON */
    .output-json {
      font-family: var(--vscode-editor-font-family, 'Cascadia Code', monospace);
      font-size: 12px;
      white-space: pre;
      overflow-x: auto;
      line-height: 1.55;
    }

    .output-badge {
      display: inline-block;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.07em;
      text-transform: uppercase;
      padding: 1px 5px;
      border-radius: 3px;
      margin-bottom: 6px;
      background: var(--vscode-badge-background, #89b4fa22);
      color: var(--vscode-badge-foreground, #89b4fa);
    }
  </style>
</head>
<body>
  <div id="header">
    <span class="title">Notebook Output</span>
    <div class="actions">
      <button id="clearBtn">Clear</button>
    </div>
  </div>

  <div id="scroll">
    <div id="placeholder">
      <!-- Simple chart icon -->
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2"/>
        <path d="M3 9h18M9 21V9"/>
        <path d="m7 15 2.5-2.5L12 15l3-3 2 2"/>
      </svg>
      <p>Rich outputs (plots, DataFrames, HTML) will appear here when you run code.</p>
    </div>
    <div id="outputs"></div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const outputsEl = document.getElementById('outputs');
    const placeholder = document.getElementById('placeholder');

    // ── Clear button ───────────────────────────────────────────────────────
    document.getElementById('clearBtn').addEventListener('click', () => {
      clearAll();
    });

    // ── Message handler ────────────────────────────────────────────────────
    window.addEventListener('message', ({ data: msg }) => {
      if (msg.type === 'clear') {
        clearAll();
      } else if (msg.type === 'add_output') {
        addOutput(msg);
      }
    });

    // ── Helpers ────────────────────────────────────────────────────────────
    function clearAll() {
      outputsEl.innerHTML = '';
      placeholder.style.display = 'flex';
    }

    function hidePlaceholder() {
      placeholder.style.display = 'none';
    }

    function addOutput({ cellId, mimeType, data }) {
      hidePlaceholder();

      const card = document.createElement('div');
      card.className = 'output-card';

      // Cell label
      if (cellId) {
        const label = document.createElement('div');
        label.className = 'cell-label';
        label.textContent = cellId;
        card.appendChild(label);
      }

      const content = document.createElement('div');
      content.className = 'output-content';

      if (mimeType.startsWith('image/')) {
        renderImage(content, mimeType, data);
      } else if (mimeType === 'text/html') {
        renderHtml(content, data);
      } else if (mimeType === 'application/json') {
        renderJson(content, data);
      } else {
        renderPlainText(content, mimeType, data);
      }

      card.appendChild(content);
      outputsEl.appendChild(card);
      card.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }

    function renderImage(container, mimeType, data) {
      const badge = document.createElement('div');
      badge.className = 'output-badge';
      badge.textContent = mimeType;
      container.appendChild(badge);

      const img = document.createElement('img');
      img.className = 'output-image';
      img.alt = mimeType;
      // data may already include the data URI prefix; strip it if so
      const base64 = data.startsWith('data:') ? data : 'data:' + mimeType + ';base64,' + data;
      img.src = base64;
      container.appendChild(img);
    }

    function renderHtml(container, data) {
      const badge = document.createElement('div');
      badge.className = 'output-badge';
      badge.textContent = 'HTML';
      container.appendChild(badge);

      const div = document.createElement('div');
      div.className = 'output-html';
      div.innerHTML = data;
      container.appendChild(div);
    }

    function renderJson(container, data) {
      const badge = document.createElement('div');
      badge.className = 'output-badge';
      badge.textContent = 'JSON';
      container.appendChild(badge);

      const pre = document.createElement('pre');
      pre.className = 'output-json';
      try {
        pre.textContent = JSON.stringify(JSON.parse(data), null, 2);
      } catch {
        pre.textContent = data;
      }
      container.appendChild(pre);
    }

    function renderPlainText(container, mimeType, data) {
      const badge = document.createElement('div');
      badge.className = 'output-badge';
      badge.textContent = mimeType;
      container.appendChild(badge);

      const pre = document.createElement('pre');
      pre.className = 'output-pre';
      pre.textContent = data;
      container.appendChild(pre);
    }
  </script>
</body>
</html>`;
}
