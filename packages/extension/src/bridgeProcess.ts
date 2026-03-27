/**
 * BridgeProcess — manages the lifecycle of the local bridge server process.
 */

import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const BRIDGE_READY_TIMEOUT_MS = 20_000;

export interface BridgeProcessInfo {
  port: number;
}

export async function startBridgeProcess(
  context: vscode.ExtensionContext,
  port: number
): Promise<BridgeProcessInfo> {
  const serverScript = resolveServerScript(context);
  console.log(`[bridge] Starting bridge from: ${serverScript}`);

  if (!fs.existsSync(serverScript)) {
    throw new Error(
      `Bridge server script not found at: ${serverScript}\n` +
        `Run "pnpm build" in the workspace root first.`
    );
  }

  const colabSpec = vscode.workspace
    .getConfiguration("notebookBridge")
    .get<string>("colabMcpUvxSpec")
    ?.trim();

  const childEnv = buildChildEnv(port, colabSpec);

  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, [serverScript], {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `Bridge did not signal ready within ${BRIDGE_READY_TIMEOUT_MS / 1000}s. ` +
            `Check the Output panel for errors.`
        )
      );
    }, BRIDGE_READY_TIMEOUT_MS);

    child.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as { ready?: boolean; port?: number };
          if (parsed.ready) {
            clearTimeout(timer);
            context.subscriptions.push({ dispose: () => child.kill() });
            resolve({ port: parsed.port ?? port });
          }
        } catch {
          console.log("[bridge stdout]", line);
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      console.error("[bridge stderr]", data.toString());
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Bridge spawn error: ${err.message}`));
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 && code !== null) {
        reject(new Error(`Bridge exited with code ${code} (signal: ${signal})`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveServerScript(context: vscode.ExtensionContext): string {
  // Dev (monorepo): extensionPath = …/packages/extension
  // Go up two levels to workspace root, then into packages/bridge/dist
  const monorepoPath = path.resolve(
    context.extensionPath,
    "..", "..",
    "packages", "bridge", "dist", "server.js"
  );
  if (fs.existsSync(monorepoPath)) return monorepoPath;

  // Packaged .vsix: bridge is bundled next to the extension
  return path.join(context.extensionPath, "bridge", "server.js");
}

function buildChildEnv(port: number, colabMcpUvxSpec?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, BRIDGE_PORT: String(port) };

  if (colabMcpUvxSpec) {
    env["COLAB_MCP_SPEC"] = colabMcpUvxSpec;
  }

  // Extend PATH with known git locations that exist on this machine.
  // We avoid shell invocations here to prevent hangs during activation.
  const gitCandidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Git\\cmd",
          "C:\\Program Files\\Git\\bin",
          "C:\\Program Files (x86)\\Git\\cmd",
          path.join(process.env["LOCALAPPDATA"] ?? "", "Programs", "Git", "cmd"),
          path.join(process.env["USERPROFILE"] ?? "", "scoop", "shims"),
          "C:\\ProgramData\\chocolatey\\bin",
        ]
      : ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];

  const extra = gitCandidates.filter((d) => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });

  if (extra.length > 0) {
    const sep = path.delimiter;
    env["PATH"] = [env["PATH"] ?? "", ...extra]
      .filter(Boolean)
      .join(sep);
  }

  return env;
}
