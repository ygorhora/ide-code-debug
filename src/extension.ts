import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { DebugBridge } from "./debug-bridge";
import { McpDebugServer } from "./mcp-server";
import {
  registerInstance,
  unregisterInstance,
} from "./instance-registry";

let mcpServer: McpDebugServer | undefined;
let serverPort: number | undefined;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("IDE Code Debug Bridge");
  context.subscriptions.push(log);

  const bridge = new DebugBridge(context, log);

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "ideCodeDebug.toggleServer";
  context.subscriptions.push(statusBarItem);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("ideCodeDebug.startServer", () =>
      startServer(bridge, log)
    ),
    vscode.commands.registerCommand("ideCodeDebug.stopServer", () =>
      stopServer(log)
    ),
    vscode.commands.registerCommand("ideCodeDebug.toggleServer", () => {
      if (mcpServer) {
        stopServer(log);
      } else {
        startServer(bridge, log);
      }
    }),
    vscode.commands.registerCommand(
      "ideCodeDebug.registerWithClaude",
      async () => {
        if (!serverPort) {
          vscode.window.showWarningMessage(
            "Debug Bridge is not running. Start it first."
          );
          return;
        }
        const terminal = vscode.window.createTerminal({
          name: "Claude MCP Setup",
        });
        terminal.sendText(
          `claude mcp remove --scope project ide-debug 2>/dev/null; claude mcp add --transport http --scope project ide-debug http://localhost:${serverPort}/mcp`
        );
        terminal.show();
      }
    ),
    vscode.commands.registerCommand(
      "ideCodeDebug.setFixedPort",
      async () => {
        const current = vscode.workspace
          .getConfiguration("ideCodeDebug")
          .get<number>("port", 3100);
        const input = await vscode.window.showInputBox({
          prompt: "Set a fixed MCP port for this workspace",
          value: String(current),
          validateInput: (v) => {
            const n = parseInt(v);
            if (isNaN(n) || n < 1024 || n > 65535) {
              return "Port must be between 1024 and 65535";
            }
            return null;
          },
        });
        if (!input) return;

        const port = parseInt(input);
        const wsConfig = vscode.workspace.getConfiguration("ideCodeDebug");
        await wsConfig.update(
          "port",
          port,
          vscode.ConfigurationTarget.Workspace
        );
        await wsConfig.update(
          "portRange",
          1,
          vscode.ConfigurationTarget.Workspace
        );

        const action = await vscode.window.showInformationMessage(
          `Fixed port set to ${port}. Restart Debug Bridge on this port?`,
          "Restart",
          "Restart & Register with Claude",
          "Later"
        );

        if (action === "Restart" || action === "Restart & Register with Claude") {
          await stopServer(log);
          await startServer(bridge, log);
        }
        if (action === "Restart & Register with Claude") {
          await vscode.commands.executeCommand(
            "ideCodeDebug.registerWithClaude"
          );
        }
      }
    )
  );

  const config = vscode.workspace.getConfiguration("ideCodeDebug");
  if (config.get<boolean>("autoStart", true)) {
    startServer(bridge, log);
  }

  log.appendLine("IDE Code Debug Bridge activated");
}

const RETRY_DELAY_MS = 1000;

/**
 * Read the port from .mcp.json in the workspace root, if it exists.
 * This ensures the extension starts on the same port Claude Code expects.
 */
function getMcpJsonPort(log: vscode.OutputChannel): number | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return undefined;

  for (const folder of folders) {
    const mcpJsonPath = path.join(folder.uri.fsPath, ".mcp.json");
    try {
      const content = fs.readFileSync(mcpJsonPath, "utf-8");
      const config = JSON.parse(content);
      const ideDebug = config?.mcpServers?.["ide-debug"];
      if (ideDebug?.url) {
        const match = ideDebug.url.match(/localhost:(\d+)/);
        if (match) {
          const port = parseInt(match[1]);
          log.appendLine(
            `[config] Found port ${port} in ${mcpJsonPath}`
          );
          return port;
        }
      }
    } catch {
      // .mcp.json doesn't exist or can't be parsed — skip
    }
  }
  return undefined;
}

async function startServer(
  bridge: DebugBridge,
  log: vscode.OutputChannel
) {
  if (mcpServer) {
    log.appendLine("Server already running");
    return;
  }

  const config = vscode.workspace.getConfiguration("ideCodeDebug");
  const mcpJsonPort = getMcpJsonPort(log);
  const basePort = mcpJsonPort ?? config.get<number>("port", 3100);
  const portRange = config.get<number>("portRange", 10);
  const retries = config.get<number>("portRetries", 3);
  const maxRequestBodyMB = config.get<number>("maxRequestBodyMB", 1);

  for (let portOffset = 0; portOffset < portRange; portOffset++) {
    const port = basePort + portOffset;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        mcpServer = new McpDebugServer(bridge, log, { maxRequestBodyMB });
        await mcpServer.start(port);

        serverPort = port;
        registerInstance(
          port,
          vscode.workspace.workspaceFolders?.map((f) => ({
            name: f.name,
            fsPath: f.uri.fsPath,
          })) ?? []
        );

        statusBarItem.text = `$(debug) Debug Bridge :${port}`;
        statusBarItem.tooltip = `MCP Debug Bridge on port ${port} — click to stop`;
        statusBarItem.show();

        log.appendLine(`MCP server listening on http://127.0.0.1:${port}/mcp`);
        vscode.window.showInformationMessage(
          `Debug Bridge MCP server running on port ${port}`
        );
        return;
      } catch (err: any) {
        mcpServer = undefined;
        const isPortBusy = err.message?.includes("already in use");

        if (isPortBusy && attempt < retries) {
          log.appendLine(
            `Port ${port} busy, retrying in ${RETRY_DELAY_MS}ms (attempt ${attempt}/${retries})...`
          );
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }

        if (isPortBusy && portOffset < portRange - 1) {
          log.appendLine(`Port ${port} busy, trying next port...`);
          break; // break retry loop, move to next port
        }

        // Non-port error or exhausted all ports
        log.appendLine(`Failed to start server: ${err.message}`);
        vscode.window.showErrorMessage(
          `Debug Bridge failed to start: ${err.message}`
        );
        return;
      }
    }
  }

  // All ports exhausted
  log.appendLine(
    `All ports ${basePort}-${basePort + portRange - 1} are busy`
  );
  vscode.window.showErrorMessage(
    `Debug Bridge: all ports ${basePort}-${basePort + portRange - 1} are in use. Change ideCodeDebug.port in settings.`
  );
}

async function stopServer(log: vscode.OutputChannel) {
  if (!mcpServer) return;

  if (serverPort !== undefined) {
    unregisterInstance(serverPort);
    serverPort = undefined;
  }
  await mcpServer.stop();
  mcpServer = undefined;
  statusBarItem.hide();
  log.appendLine("MCP server stopped");
}

export async function deactivate() {
  if (serverPort !== undefined) {
    unregisterInstance(serverPort);
    serverPort = undefined;
  }
  if (mcpServer) {
    await mcpServer.stop();
    mcpServer = undefined;
  }
}
