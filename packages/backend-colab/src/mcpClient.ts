/**
 * ColabMcpClient — wrapper around googlecolab/colab-mcp.
 *
 * Tool schemas verified from live server output on 2026-03-23.
 * The server exposes ONE tool initially: open_colab_browser_connection.
 * After that call succeeds, 7 more tools become available:
 *
 *   add_code_cell    add_text_cell   delete_cell   get_cells
 *   move_cell        run_code_cell   update_cell
 */

import { existsSync } from "fs";
import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ---------------------------------------------------------------------------
// Verified arg / result types (from live schema logs)
// ---------------------------------------------------------------------------

/** open_colab_browser_connection — no args, returns true on success */
export type OpenBrowserConnectionResult = boolean | Record<string, unknown>;

export interface AddCodeCellArgs {
  cellIndex: number;
  language: "python" | "r";
  code?: string;
  [k: string]: unknown;
}
export interface AddCodeCellResult {
  cellId?: string;
  cell_id?: string;
  [k: string]: unknown;
}

export interface AddTextCellArgs {
  cellIndex: number;
  content?: string;
  [k: string]: unknown;
}

export interface UpdateCellArgs {
  cellId: string;
  content?: string;
  [k: string]: unknown;
}

export interface DeleteCellArgs {
  cellId?: string;
  [k: string]: unknown;
}

export interface MoveCellArgs {
  cellId: string;
  cellIndex: number;
  [k: string]: unknown;
}

export interface GetCellsArgs {
  cellIndexStart?: number;
  cellIndexEnd?: number;
  includeOutputs?: boolean;
  [k: string]: unknown;
}
export interface CellInfo {
  id?: string;
  cellId?: string;
  cell_id?: string;
  type?: string;
  cell_type?: string;
  source?: string;
  code?: string;
  content?: string;
  outputs?: Array<Record<string, unknown>>;
  executionCount?: number | null;
  execution_count?: number | null;
  [k: string]: unknown;
}
export interface GetCellsResult {
  cells?: CellInfo[];
  [k: string]: unknown;
}

export interface RunCodeCellArgs {
  cellId?: string;
  [k: string]: unknown;
}
export interface RunCodeCellResult {
  outputs?: Array<{
    outputType?: string;
    output_type?: string;
    text?: string;
    data?: Record<string, string>;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ColabMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private availableTools: Set<string> = new Set();

  async connect(): Promise<void> {
    if (this.client) return;

    this.transport = new StdioClientTransport({
      command: "uvx",
      args: ["git+https://github.com/googlecolab/colab-mcp"],
      env: buildEnvWithTools(),
    });

    this.client = new Client(
      { name: "cursor-notebook-bridge", version: "0.1.0" },
      { capabilities: {} }
    );

    await this.client.connect(this.transport);
    await this.discoverTools();
    console.log("[ColabMcpClient] Connected. Available tools:", Array.from(this.availableTools).join(", "));
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.transport = null;
      this.availableTools.clear();
    }
  }

  hasTool(name: string): boolean {
    return this.availableTools.has(name);
  }

  getAvailableTools(): string[] {
    return Array.from(this.availableTools);
  }

  async rediscoverTools(): Promise<void> {
    await this.discoverTools();
    console.log("[ColabMcpClient] Tools after rediscovery:", Array.from(this.availableTools).join(", "));
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  async openBrowserConnection(): Promise<OpenBrowserConnectionResult> {
    return this.call<OpenBrowserConnectionResult>("open_colab_browser_connection", {});
  }

  async addCodeCell(args: AddCodeCellArgs): Promise<AddCodeCellResult> {
    return this.call<AddCodeCellResult>("add_code_cell", args);
  }

  async addTextCell(args: AddTextCellArgs): Promise<void> {
    await this.call("add_text_cell", args);
  }

  async updateCell(args: UpdateCellArgs): Promise<void> {
    await this.call("update_cell", args);
  }

  async deleteCell(args: DeleteCellArgs): Promise<void> {
    await this.call("delete_cell", args);
  }

  async moveCell(args: MoveCellArgs): Promise<void> {
    await this.call("move_cell", args);
  }

  async getCells(args: GetCellsArgs): Promise<GetCellsResult> {
    return this.call<GetCellsResult>("get_cells", args);
  }

  async runCodeCell(args: RunCodeCellArgs): Promise<RunCodeCellResult> {
    return this.call<RunCodeCellResult>("run_code_cell", args);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async discoverTools(): Promise<void> {
    if (!this.client) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (this.client as any).listTools();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tools: Array<{ name: string; inputSchema?: unknown }> = result?.tools ?? [];
      this.availableTools = new Set(tools.map((t) => t.name));
      for (const tool of tools) {
        console.log(`[ColabMcpClient] Tool "${tool.name}" schema:`, JSON.stringify(tool.inputSchema ?? {}, null, 2));
      }
    } catch (err) {
      console.warn("[ColabMcpClient] Could not list tools:", err);
    }
  }

  private async call<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
    if (!this.client) throw new Error("ColabMcpClient not connected.");

    const result = await this.client.callTool({ name: toolName, arguments: args });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = result as any;
    const content: Array<{ type: string; text?: string }> = Array.isArray(r.content) ? r.content : [];

    if (r.isError === true) {
      const msg = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      throw new Error(`colab-mcp tool "${toolName}" returned error: ${msg}`);
    }

    const textBlock = content.find((c) => c.type === "text");
    if (!textBlock?.text) return {} as T;

    // Some tools return a plain boolean as text ("true"/"false")
    if (textBlock.text.trim() === "true") return true as unknown as T;
    if (textBlock.text.trim() === "false") return false as unknown as T;

    try {
      return JSON.parse(textBlock.text) as T;
    } catch {
      return { text: textBlock.text } as unknown as T;
    }
  }
}

// ---------------------------------------------------------------------------
// Environment — ensure git and uvx are on PATH for child processes
// ---------------------------------------------------------------------------

function buildEnvWithTools(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }

  const userProfile = process.env["USERPROFILE"] ?? "";
  const localAppData = process.env["LOCALAPPDATA"] ?? "";
  const appData = process.env["APPDATA"] ?? "";

  const candidates =
    process.platform === "win32"
      ? [
          // Git
          "C:\\Program Files\\Git\\cmd",
          "C:\\Program Files\\Git\\bin",
          path.join(localAppData, "Programs", "Git", "cmd"),
          // Anaconda/Miniconda (common uv location)
          path.join(userProfile, "anaconda3", "Scripts"),
          path.join(userProfile, "anaconda3"),
          path.join(userProfile, "miniconda3", "Scripts"),
          path.join(userProfile, "Anaconda3", "Scripts"),
          path.join(userProfile, "Miniconda3", "Scripts"),
          "C:\\ProgramData\\anaconda3\\Scripts",
          // Standard Python Scripts
          path.join(localAppData, "Programs", "Python", "Python312", "Scripts"),
          path.join(localAppData, "Programs", "Python", "Python311", "Scripts"),
          path.join(localAppData, "Programs", "Python", "Python310", "Scripts"),
          "C:\\Python312\\Scripts",
          "C:\\Python311\\Scripts",
          // uv self-install location
          path.join(userProfile, ".local", "bin"),
          path.join(userProfile, ".cargo", "bin"),
          // Scoop / Chocolatey / pipx
          path.join(userProfile, "scoop", "shims"),
          "C:\\ProgramData\\chocolatey\\bin",
          path.join(appData, "Python", "Scripts"),
        ]
      : ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", path.join(userProfile, ".local", "bin")];

  const extras = candidates.filter((d) => { try { return existsSync(d); } catch { return false; } });

  if (extras.length > 0) {
    env["PATH"] = [env["PATH"] ?? "", ...extras].filter(Boolean).join(path.delimiter);
  }

  return env;
}
