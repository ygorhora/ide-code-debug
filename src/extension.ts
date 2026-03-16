import * as vscode from "vscode";
import { DebugBridge } from "./debug-bridge";
import { McpDebugServer } from "./mcp-server";

let mcpServer: McpDebugServer | undefined;
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
    })
  );

  const config = vscode.workspace.getConfiguration("ideCodeDebug");
  if (config.get<boolean>("autoStart", true)) {
    startServer(bridge, log);
  }

  log.appendLine("IDE Code Debug Bridge activated");
}

const RETRY_DELAY_MS = 1000;

async function startServer(
  bridge: DebugBridge,
  log: vscode.OutputChannel
) {
  if (mcpServer) {
    log.appendLine("Server already running");
    return;
  }

  const config = vscode.workspace.getConfiguration("ideCodeDebug");
  const basePort = config.get<number>("port", 3100);
  const portRange = config.get<number>("portRange", 10);
  const retries = config.get<number>("portRetries", 3);
  const maxRequestBodyMB = config.get<number>("maxRequestBodyMB", 1);

  for (let portOffset = 0; portOffset < portRange; portOffset++) {
    const port = basePort + portOffset;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        mcpServer = new McpDebugServer(bridge, log, { maxRequestBodyMB });
        await mcpServer.start(port);

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

  await mcpServer.stop();
  mcpServer = undefined;
  statusBarItem.hide();
  log.appendLine("MCP server stopped");
}

export async function deactivate() {
  if (mcpServer) {
    await mcpServer.stop();
    mcpServer = undefined;
  }
}
