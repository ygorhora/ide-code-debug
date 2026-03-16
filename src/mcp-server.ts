import * as http from "http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { OutputChannel } from "vscode";
import { DebugBridge } from "./debug-bridge";

const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_SESSIONS = 10;

const sessionIdParam = z
  .string()
  .optional()
  .describe(
    "Target a specific debug session by ID or name. Omit to use the active session."
  );

const threadIdParam = z
  .number()
  .optional()
  .describe("Thread ID. Defaults to stopped thread.");

interface ManagedSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
}

export interface McpServerOptions {
  maxRequestBodyMB: number;
}

export class McpDebugServer {
  private httpServer: http.Server | null = null;
  private sessions = new Map<string, ManagedSession>();
  private reaperInterval: ReturnType<typeof setInterval> | null = null;
  private maxBodyBytes: number;

  constructor(
    private bridge: DebugBridge,
    private log: OutputChannel,
    options?: McpServerOptions
  ) {
    this.maxBodyBytes = Math.round((options?.maxRequestBodyMB ?? 1) * 1024 * 1024);
  }

  /** Create a fresh McpServer with all tools registered */
  private createMcpServer(): McpServer {
    const s = new McpServer({
      name: "ide-code-debug",
      version: "0.1.0",
    });

    this.registerTools(s);
    return s;
  }

  // ─── Tool Registration ─────────────────────────────────────

  private registerTools(s: McpServer) {
    const b = this.bridge;

    s.registerTool("get_state", {
      description:
        "Get the current debugger state: active session, paused status, current file/line, stop reason, and list of all sessions",
    }, async () => ok(b.getState()));

    s.registerTool("list_sessions", {
      description:
        "List all active debug sessions with their ID, name, type, paused status, and current position. Use the ID or name to target a specific session in other tools.",
    }, async () => ok(b.listSessions()));

    s.registerTool("get_launch_configs", {
      description:
        "List available debug launch configurations from .vscode/launch.json",
    }, async () => ok(await b.getLaunchConfigs()));

    // --- Session Control ---

    s.registerTool("start_session", {
      description:
        "Start a debug session. Optionally specify a launch configuration name.",
      inputSchema: {
        configName: z
          .string()
          .optional()
          .describe(
            "Name of the launch configuration (from launch.json). Omit to use the default."
          ),
      },
    }, async ({ configName }) => ok(await b.startSession(configName)));

    s.registerTool("stop_session", {
      description: "Stop a debug session",
      inputSchema: { sessionId: sessionIdParam },
    }, async ({ sessionId }) => {
      await b.stopSession(sessionId);
      return ok({ message: "Debug session stopped" });
    });

    s.registerTool("restart_session", {
      description:
        "Restart a debug session (stop + start with same configuration)",
      inputSchema: { sessionId: sessionIdParam },
    }, async ({ sessionId }) => ok(await b.restartSession(sessionId)));

    // --- Breakpoints ---

    s.registerTool("set_breakpoints", {
      description:
        "Set breakpoints at specific lines in a file. They appear visually in the IDE without modifying source code.",
      inputSchema: {
        file: z.string().describe("Absolute path to the source file"),
        lines: z
          .array(z.number())
          .describe("Line numbers (1-based) where breakpoints should be set"),
        condition: z
          .string()
          .optional()
          .describe(
            "Optional condition expression — breakpoint only triggers when this is truthy"
          ),
      },
    }, async ({ file, lines, condition }) =>
      ok(b.setBreakpoints(file, lines, condition))
    );

    s.registerTool("remove_breakpoints", {
      description:
        "Remove breakpoints from a file. If lines omitted, removes ALL breakpoints in that file.",
      inputSchema: {
        file: z.string().describe("Absolute path to the source file"),
        lines: z
          .array(z.number())
          .optional()
          .describe(
            "Specific line numbers to remove. Omit to remove all in file."
          ),
      },
    }, async ({ file, lines }) => {
      const count = b.removeBreakpoints(file, lines);
      return ok({ removed: count });
    });

    s.registerTool("list_breakpoints", {
      description: "List all active breakpoints across all files",
    }, async () => ok(b.listBreakpoints()));

    // --- Code Search ---

    s.registerTool("find_code_line", {
      description:
        "Search for a code snippet in a file and return matching line numbers. Use this BEFORE set_breakpoints to find the exact line.",
      inputSchema: {
        file: z.string().describe("Absolute path to the source file"),
        pattern: z
          .string()
          .describe(
            "Code snippet to search for (e.g. 'return await get_current_time()')"
          ),
      },
    }, async ({ file, pattern }) => {
      const matches = await b.findCodeLine(file, pattern);
      return ok(
        matches.length === 0
          ? { matches: [], message: `No matches found for "${pattern}"` }
          : { matches }
      );
    });

    // --- Execution Control ---

    const executionTools: Array<{
      name: string;
      desc: string;
      method: keyof DebugBridge;
      msg: string;
    }> = [
      { name: "continue_execution", desc: "Resume execution until the next breakpoint or program end", method: "continueExecution", msg: "Execution continued" },
      { name: "step_over", desc: "Execute the current line and stop at the next line in the same function (step over calls)", method: "stepOver", msg: "Stepped over" },
      { name: "step_into", desc: "Step into the function call on the current line", method: "stepInto", msg: "Stepped into" },
      { name: "step_out", desc: "Step out of the current function, returning to the caller", method: "stepOut", msg: "Stepped out" },
      { name: "pause", desc: "Pause execution of a running program", method: "pause", msg: "Execution paused" },
    ];

    for (const tool of executionTools) {
      s.registerTool(tool.name, {
        description: tool.desc,
        inputSchema: { threadId: threadIdParam, sessionId: sessionIdParam },
      }, async ({ threadId, sessionId }) => {
        await (b[tool.method] as any)(threadId, sessionId);
        return ok({ message: tool.msg });
      });
    }

    // --- Inspection ---

    s.registerTool("get_threads", {
      description: "List all active threads in the debug session",
      inputSchema: { sessionId: sessionIdParam },
    }, async ({ sessionId }) => ok(await b.getThreads(sessionId)));

    s.registerTool("get_stack_trace", {
      description: "Get the call stack (stack frames) of a paused thread",
      inputSchema: {
        threadId: z
          .number()
          .optional()
          .describe("Thread ID. Defaults to stopped thread."),
        levels: z
          .number()
          .optional()
          .describe("Max number of frames to return (default: 20)"),
        sessionId: sessionIdParam,
      },
    }, async ({ threadId, levels, sessionId }) => {
      const frames = await b.getStackTrace(threadId, levels, sessionId);
      return ok(
        frames.map((f: any) => ({
          id: f.id,
          name: f.name,
          file: f.source?.path || f.source?.name,
          line: f.line,
          column: f.column,
        }))
      );
    });

    s.registerTool("get_variables", {
      description:
        "Get variables in scope. Smart resolution: automatically resolves thread → frame → scope → variables. No need to chain multiple calls.",
      inputSchema: {
        threadId: z
          .number()
          .optional()
          .describe("Thread ID. Defaults to stopped thread."),
        frameIndex: z
          .number()
          .optional()
          .describe("Stack frame index (0 = top of stack). Default: 0"),
        scope: z
          .enum(["local", "global", "all"])
          .optional()
          .describe("Which variable scope to show. Default: local"),
        depth: z
          .number()
          .optional()
          .describe(
            "How many levels to expand nested objects/arrays (0-3). Default: 1"
          ),
        sessionId: sessionIdParam,
      },
    }, async ({ threadId, frameIndex, scope, depth, sessionId }) =>
      ok(
        await b.getVariables({
          threadId,
          frameIndex,
          scope,
          depth,
          sessionId,
        })
      )
    );

    s.registerTool("evaluate", {
      description:
        "Evaluate an expression in the context of the current debug frame. Can read variables, call functions, compare values. Auto-searches other stack frames on NameError.",
      inputSchema: {
        expression: z
          .string()
          .describe(
            "Expression to evaluate (e.g. 'order_id', 'len(items)', 'response.status_code == 200')"
          ),
        frameId: z
          .number()
          .optional()
          .describe(
            "Frame ID to evaluate in. Defaults to current top frame."
          ),
        context: z
          .enum(["watch", "repl", "hover"])
          .optional()
          .describe("Evaluation context. Default: watch"),
        sessionId: sessionIdParam,
      },
    }, async ({ expression, frameId, context, sessionId }) =>
      ok(await b.evaluate(expression, frameId, context, sessionId))
    );

    // --- Wait ---

    s.registerTool("wait_for_stop", {
      description:
        "Block until the debugger pauses (breakpoint hit, step complete, exception caught). Returns immediately if already paused. Use after continue/start to wait for the next stop.",
      inputSchema: {
        timeoutMs: z
          .number()
          .optional()
          .describe("Max wait time in ms. Default: 30000 (30 seconds)"),
        sessionId: sessionIdParam,
      },
    }, async ({ timeoutMs, sessionId }) => {
      try {
        const event = await b.waitForStop(timeoutMs, sessionId);
        return ok({
          stopped: true,
          reason: event.reason,
          threadId: event.threadId,
          description: event.description,
          sessionId: event.sessionId,
        });
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                stopped: false,
                error: err.message,
              }),
            },
          ],
          isError: true,
        };
      }
    });
  }

  // ─── HTTP Server ───────────────────────────────────────────

  async start(port: number): Promise<void> {
    // Reap idle sessions periodically
    this.reaperInterval = setInterval(() => this.reapIdleSessions(), 60_000);

    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer(async (req, res) => {
        const url = new URL(req.url || "/", `http://localhost:${port}`);

        try {
          if (url.pathname === "/mcp") {
            await this.handleMcpRequest(req, res);
          } else if (req.method === "GET" && url.pathname === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                status: "ok",
                server: "ide-code-debug",
                version: "0.1.0",
                activeSessions: this.sessions.size,
              })
            );
          } else {
            res.writeHead(404);
            res.end(
              "Not found. Use POST /mcp for MCP or GET /health for status."
            );
          }
        } catch (err: any) {
          this.log.appendLine(`[http] Error: ${err.message}`);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end("Internal server error");
          }
        }
      });

      this.httpServer.on("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${port} is already in use`));
        } else {
          reject(err);
        }
      });

      this.httpServer.listen(port, "127.0.0.1", () => {
        resolve();
      });
    });
  }

  private async handleMcpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ) {
    // Pre-parse body so we can inspect it before routing
    let body: any;
    if (req.method === "POST") {
      try {
        body = await readBody(req, this.maxBodyBytes);
      } catch (err: any) {
        const isBodyTooLarge = err.message?.includes("too large");
        const status = isBodyTooLarge ? 413 : 400;
        const limitMB = (this.maxBodyBytes / 1024 / 1024).toFixed(1);
        const message = isBodyTooLarge
          ? `Request body exceeds the ${limitMB} MB limit. You can increase this in VS Code settings: ideCodeDebug.maxRequestBodyMB`
          : `Invalid request body: ${err.message}`;

        this.log.appendLine(`[mcp] ${message}`);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: isBodyTooLarge ? -32001 : -32700, message },
          id: null,
        }));
        return;
      }
    }

    if (isInitializeRequest(body)) {
      if (this.sessions.size >= MAX_SESSIONS) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Too many active sessions" },
            id: null,
          })
        );
        return;
      }

      this.log.appendLine("[mcp] New client session");

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const server = this.createMcpServer();

      await server.connect(transport);
      await transport.handleRequest(req, res, body);

      if (transport.sessionId) {
        this.sessions.set(transport.sessionId, {
          transport,
          server,
          lastActivity: Date.now(),
        });

        transport.onclose = () => {
          this.sessions.delete(transport.sessionId!);
          this.log.appendLine(
            `[mcp] Session closed: ${transport.sessionId}`
          );
        };

        transport.onerror = (err) => {
          this.log.appendLine(
            `[mcp] Transport error (${transport.sessionId}): ${err.message}`
          );
        };
      }
      return;
    }

    // Route to existing session
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;

    if (session) {
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res, body);
      return;
    }

    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32600,
          message: "No valid session. Send initialize first.",
        },
        id: null,
      })
    );
  }

  private reapIdleSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity > SESSION_IDLE_TIMEOUT_MS) {
        this.log.appendLine(`[mcp] Reaping idle session: ${id}`);
        session.transport.close().catch((err) => {
          this.log.appendLine(`[mcp] Error closing session ${id}: ${err.message}`);
        });
        this.sessions.delete(id);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = null;
    }

    await Promise.all(
      Array.from(this.sessions.values()).map((s) =>
        s.transport.close().catch(() => {})
      )
    );
    this.sessions.clear();

    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
        this.httpServer = null;
      } else {
        resolve();
      }
    });
  }
}

// ─── Helpers ───────────────────────────────────────────────

function ok(data: any) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : undefined);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function isInitializeRequest(body: any): boolean {
  if (!body) return false;
  if (Array.isArray(body)) {
    return body.some((msg: any) => msg.method === "initialize");
  }
  return body.method === "initialize";
}
