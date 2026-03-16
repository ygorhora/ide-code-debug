import * as path from "path";
import * as vscode from "vscode";
import { EventEmitter } from "events";
import picomatch from "picomatch";

export interface StoppedEvent {
  threadId: number;
  reason: string;
  description?: string;
  allThreadsStopped?: boolean;
  sessionId?: string;
}

export interface DebugStateSnapshot {
  isActive: boolean;
  isPaused: boolean;
  sessionName?: string;
  sessionType?: string;
  sessionId?: string;
  stopReason?: string;
  threadId?: number;
  currentFile?: string;
  currentLine?: number;
  sessions: Array<{
    id: string;
    name: string;
    type: string;
    isPaused: boolean;
  }>;
}

interface SessionState {
  session: vscode.DebugSession;
  lastStoppedEvent: StoppedEvent | null;
  stoppedFrameId: number | undefined;
  currentFile: string | undefined;
  currentLine: number | undefined;
  isPaused: boolean;
}

export class DebugBridge extends EventEmitter {
  private sessions = new Map<string, SessionState>();
  private pathMatcher: ((file: string) => boolean) | null = null;

  constructor(
    context: vscode.ExtensionContext,
    private log: vscode.OutputChannel
  ) {
    super();

    // Intercept DAP messages from ALL debug adapter types
    context.subscriptions.push(
      vscode.debug.registerDebugAdapterTrackerFactory("*", {
        createDebugAdapterTracker: (session: vscode.DebugSession) => {
          return this.createTracker(session);
        },
      })
    );

    // Session lifecycle events
    context.subscriptions.push(
      vscode.debug.onDidStartDebugSession((session) => {
        this.log.appendLine(
          `[session] Started: ${session.name} (${session.type}) [${session.id}]`
        );
        this.sessions.set(session.id, {
          session,
          lastStoppedEvent: null,
          stoppedFrameId: undefined,
          currentFile: undefined,
          currentLine: undefined,
          isPaused: false,
        });
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        this.log.appendLine(`[session] Terminated: ${session.name}`);
        this.sessions.delete(session.id);
        this.emit("terminated", session.id);
      })
    );

    this.loadAllowedPaths();

    // Reload allowed paths when settings change
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("ideCodeDebug.allowedPaths")) {
          this.loadAllowedPaths();
        }
      })
    );
  }

  private loadAllowedPaths() {
    const patterns = vscode.workspace
      .getConfiguration("ideCodeDebug")
      .get<string[]>("allowedPaths", []);

    if (patterns.length === 0) {
      this.pathMatcher = null;
      this.log.appendLine("[security] File path restriction: disabled (all files allowed)");
    } else {
      this.pathMatcher = picomatch(patterns);
      this.log.appendLine(
        `[security] File path restriction: ${patterns.join(", ")}`
      );
    }
  }

  assertPathAllowed(file: string): void {
    if (!this.pathMatcher) return;

    const resolved = path.resolve(file);
    if (!this.pathMatcher(resolved)) {
      throw new Error(
        `Access denied: "${resolved}" is outside the allowed paths. ` +
        `Configure ideCodeDebug.allowedPaths in VS Code settings to adjust.`
      );
    }
  }

  private createTracker(
    session: vscode.DebugSession
  ): vscode.DebugAdapterTracker {
    return {
      onDidSendMessage: (message: any) => {
        if (message.type !== "event") return;

        switch (message.event) {
          case "stopped":
            this.handleStopped(session, message.body);
            break;
          case "continued": {
            const s = this.sessions.get(session.id);
            if (s) s.isPaused = false;
            this.emit("continued", session.id);
            break;
          }
        }
      },
    };
  }

  private async handleStopped(session: vscode.DebugSession, body: any) {
    const event: StoppedEvent = {
      threadId: body.threadId,
      reason: body.reason,
      description: body.description,
      allThreadsStopped: body.allThreadsStopped,
      sessionId: session.id,
    };

    const state = this.sessions.get(session.id);
    if (state) {
      state.lastStoppedEvent = event;
      state.isPaused = true;
    }

    // Auto-resolve top frame
    try {
      const resp = await session.customRequest("stackTrace", {
        threadId: body.threadId,
        startFrame: 0,
        levels: 1,
      });
      if (resp.stackFrames?.length > 0 && state) {
        const frame = resp.stackFrames[0];
        state.stoppedFrameId = frame.id;
        state.currentFile = frame.source?.path;
        state.currentLine = frame.line;
      }
    } catch {
      // Non-critical
    }

    this.log.appendLine(
      `[stopped] ${body.reason} at thread ${body.threadId} [${session.name}]` +
        (state?.currentFile
          ? ` — ${state.currentFile}:${state.currentLine}`
          : "")
    );
    this.emit("stopped", event);
  }

  // ─── Session Resolution ────────────────────────────────────

  /**
   * Resolve a session by ID, name, or fall back to the active session.
   * Accepts partial name match (case-insensitive).
   */
  private resolveSession(sessionId?: string): {
    session: vscode.DebugSession;
    state: SessionState;
  } {
    if (sessionId) {
      // Try exact ID match first
      const byId = this.sessions.get(sessionId);
      if (byId) return { session: byId.session, state: byId };

      // Try name match (case-insensitive, partial)
      const lower = sessionId.toLowerCase();
      for (const state of this.sessions.values()) {
        if (state.session.name.toLowerCase().includes(lower)) {
          return { session: state.session, state };
        }
      }

      throw new Error(
        `Session "${sessionId}" not found. Available: ${this.listSessionNames()}`
      );
    }

    // Fall back to active session
    const active = vscode.debug.activeDebugSession;
    if (!active) throw new Error("No active debug session");

    const state = this.sessions.get(active.id);
    if (!state) throw new Error("Active session not tracked");

    return { session: active, state };
  }

  private listSessionNames(): string {
    const sessions = this.listSessions();
    if (sessions.length === 0) return "(none)";
    return sessions.map((s) => `${s.name} [${s.id}]`).join(", ");
  }

  private getThreadId(state: SessionState, threadId?: number): number {
    const id = threadId ?? state.lastStoppedEvent?.threadId;
    if (id === undefined)
      throw new Error("No thread ID available — debugger may not be paused");
    return id;
  }

  // ─── State ──────────────────────────────────────────────────

  getState(): DebugStateSnapshot {
    const active = vscode.debug.activeDebugSession;
    const activeState = active ? this.sessions.get(active.id) : undefined;

    return {
      isActive: !!active,
      isPaused: activeState?.isPaused ?? false,
      sessionName: active?.name,
      sessionType: active?.type,
      sessionId: active?.id,
      stopReason: activeState?.lastStoppedEvent?.reason,
      threadId: activeState?.lastStoppedEvent?.threadId,
      currentFile: activeState?.currentFile,
      currentLine: activeState?.currentLine,
      sessions: this.listSessions(),
    };
  }

  listSessions(): Array<{
    id: string;
    name: string;
    type: string;
    isPaused: boolean;
    isActive: boolean;
    currentFile?: string;
    currentLine?: number;
  }> {
    const activeId = vscode.debug.activeDebugSession?.id;
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.session.id,
      name: s.session.name,
      type: s.session.type,
      isPaused: s.isPaused,
      isActive: s.session.id === activeId,
      currentFile: s.currentFile,
      currentLine: s.currentLine,
    }));
  }

  // ─── Session Control ───────────────────────────────────────

  async getLaunchConfigs(): Promise<any[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) return [];

    const configs: any[] = [];
    for (const folder of folders) {
      const launch = vscode.workspace.getConfiguration("launch", folder.uri);
      const items = launch.get<any[]>("configurations", []);
      configs.push(
        ...items.map((c) => ({
          name: c.name,
          type: c.type,
          request: c.request,
          folder: folder.name,
        }))
      );
    }
    return configs;
  }

  async startSession(
    configName?: string
  ): Promise<{ success: boolean; message: string }> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      return { success: false, message: "No workspace folder open" };
    }

    let config: vscode.DebugConfiguration | undefined;

    if (configName) {
      const allNames: string[] = [];
      for (const folder of folders) {
        const launch = vscode.workspace.getConfiguration("launch", folder.uri);
        const items = launch.get<any[]>("configurations", []);
        for (const c of items) {
          allNames.push(c.name);
          if (c.name === configName) config = c;
        }
        if (config) break;
      }
      if (!config) {
        const names = allNames.join(", ");
        return {
          success: false,
          message: `Config "${configName}" not found. Available: ${names || "(none)"}`,
        };
      }
    }

    const started = await vscode.debug.startDebugging(
      folders[0],
      config || ""
    );
    return {
      success: started,
      message: started
        ? `Debug session started${configName ? `: ${configName}` : ""}`
        : "Failed to start debug session",
    };
  }

  async stopSession(sessionId?: string): Promise<void> {
    const { session } = this.resolveSession(sessionId);
    await vscode.debug.stopDebugging(session);
  }

  async restartSession(
    sessionId?: string
  ): Promise<{ success: boolean; message: string }> {
    const { session } = this.resolveSession(sessionId);
    // workbench.action.debug.restart acts on the active session,
    // so we use the session-specific restart via stop + start
    const config = session.configuration;
    const folder = vscode.workspace.workspaceFolders?.[0];
    await vscode.debug.stopDebugging(session);
    const started = await vscode.debug.startDebugging(folder, config);
    return {
      success: started,
      message: started
        ? `Debug session restarted: ${session.name}`
        : "Failed to restart debug session",
    };
  }

  // ─── Breakpoints ───────────────────────────────────────────

  setBreakpoints(
    file: string,
    lines: number[],
    condition?: string
  ): { file: string; lines: number[] } {
    this.assertPathAllowed(file);
    const uri = vscode.Uri.file(file);
    const breakpoints = lines.map(
      (line) =>
        new vscode.SourceBreakpoint(
          new vscode.Location(uri, new vscode.Position(line - 1, 0)),
          true,
          condition
        )
    );
    vscode.debug.addBreakpoints(breakpoints);
    return { file, lines };
  }

  removeBreakpoints(file: string, lines?: number[]): number {
    this.assertPathAllowed(file);
    const toRemove = vscode.debug.breakpoints.filter((bp) => {
      if (!(bp instanceof vscode.SourceBreakpoint)) return false;
      if (bp.location.uri.fsPath !== file) return false;
      if (lines && lines.length > 0) {
        return lines.includes(bp.location.range.start.line + 1);
      }
      return true;
    });

    if (toRemove.length > 0) {
      vscode.debug.removeBreakpoints(toRemove);
    }
    return toRemove.length;
  }

  listBreakpoints(): Array<{
    file: string;
    line: number;
    enabled: boolean;
    condition?: string;
  }> {
    return vscode.debug.breakpoints
      .filter(
        (bp): bp is vscode.SourceBreakpoint =>
          bp instanceof vscode.SourceBreakpoint
      )
      .map((bp) => ({
        file: bp.location.uri.fsPath,
        line: bp.location.range.start.line + 1,
        enabled: bp.enabled,
        condition: bp.condition,
      }));
  }

  // ─── Code Search ────────────────────────────────────────────

  async findCodeLine(
    file: string,
    pattern: string
  ): Promise<Array<{ line: number; text: string }>> {
    this.assertPathAllowed(file);
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(file)
    );
    const results: Array<{ line: number; text: string }> = [];

    for (let i = 0; i < doc.lineCount; i++) {
      const lineText = doc.lineAt(i).text;
      if (lineText.includes(pattern)) {
        results.push({ line: i + 1, text: lineText.trimStart() });
      }
    }

    return results;
  }

  // ─── Execution Control ─────────────────────────────────────

  private async sendThreadCommand(
    command: string,
    threadId?: number,
    sessionId?: string
  ): Promise<void> {
    const { session, state } = this.resolveSession(sessionId);
    await session.customRequest(command, {
      threadId: this.getThreadId(state, threadId),
    });
  }

  continueExecution(threadId?: number, sessionId?: string) {
    return this.sendThreadCommand("continue", threadId, sessionId);
  }
  stepOver(threadId?: number, sessionId?: string) {
    return this.sendThreadCommand("next", threadId, sessionId);
  }
  stepInto(threadId?: number, sessionId?: string) {
    return this.sendThreadCommand("stepIn", threadId, sessionId);
  }
  stepOut(threadId?: number, sessionId?: string) {
    return this.sendThreadCommand("stepOut", threadId, sessionId);
  }
  pause(threadId?: number, sessionId?: string) {
    return this.sendThreadCommand("pause", threadId, sessionId);
  }

  // ─── Inspection ────────────────────────────────────────────

  async getThreads(sessionId?: string): Promise<any[]> {
    const { session } = this.resolveSession(sessionId);
    const resp = await session.customRequest("threads");
    return resp.threads || [];
  }

  async getStackTrace(
    threadId?: number,
    levels?: number,
    sessionId?: string
  ): Promise<any[]> {
    const { session, state } = this.resolveSession(sessionId);
    const resp = await session.customRequest("stackTrace", {
      threadId: this.getThreadId(state, threadId),
      startFrame: 0,
      levels: levels || 20,
    });
    return resp.stackFrames || [];
  }

  async getScopes(frameId?: number, sessionId?: string): Promise<any[]> {
    const { session, state } = this.resolveSession(sessionId);
    const fId = frameId ?? state.stoppedFrameId;
    if (fId === undefined)
      throw new Error("No frame ID available — get stack trace first");

    const resp = await session.customRequest("scopes", { frameId: fId });
    return resp.scopes || [];
  }

  async getVariablesRaw(
    variablesReference: number,
    sessionId?: string
  ): Promise<any[]> {
    const { session } = this.resolveSession(sessionId);
    const resp = await session.customRequest("variables", {
      variablesReference,
    });
    return resp.variables || [];
  }

  async getVariables(options?: {
    threadId?: number;
    frameIndex?: number;
    scope?: "local" | "global" | "all";
    depth?: number;
    sessionId?: string;
  }): Promise<any> {
    const opts = {
      scope: "local" as const,
      depth: 1,
      frameIndex: 0,
      ...options,
    };

    const frames = await this.getStackTrace(
      opts.threadId,
      undefined,
      opts.sessionId
    );
    if (frames.length === 0) throw new Error("No stack frames available");
    const frame = frames[opts.frameIndex] || frames[0];

    const scopes = await this.getScopes(frame.id, opts.sessionId);

    const filtered = scopes.filter((s: any) => {
      if (opts.scope === "all") return true;
      const name = s.name.toLowerCase();
      if (opts.scope === "local")
        return name.includes("local") || name === "locals";
      if (opts.scope === "global")
        return name.includes("global") || name === "globals";
      return true;
    });

    const result: any = {
      frame: {
        name: frame.name,
        file: frame.source?.path || frame.source?.name,
        line: frame.line,
      },
      scopes: {},
    };

    await Promise.all(
      filtered.map(async (scope: any) => {
        const vars = await this.getVariablesRaw(
          scope.variablesReference,
          opts.sessionId
        );
        result.scopes[scope.name] = await this.expandVariables(
          vars,
          opts.depth,
          opts.sessionId
        );
      })
    );

    return result;
  }

  private async expandVariables(
    variables: any[],
    depth: number,
    sessionId?: string
  ): Promise<any[]> {
    const capped = variables.slice(0, 100);

    return Promise.all(
      capped.map(async (v) => {
        const item: any = {
          name: v.name,
          value: v.value,
          type: v.type,
        };

        if (depth > 0 && v.variablesReference > 0) {
          try {
            const children = await this.getVariablesRaw(
              v.variablesReference,
              sessionId
            );
            item.children = await this.expandVariables(
              children.slice(0, 50),
              depth - 1,
              sessionId
            );
          } catch {
            // Some variables can't be expanded
          }
        }

        return item;
      })
    );
  }

  async evaluate(
    expression: string,
    frameId?: number,
    context?: string,
    sessionId?: string
  ): Promise<any> {
    const { session, state } = this.resolveSession(sessionId);
    const fId = frameId ?? state.stoppedFrameId;
    const ctx = context || "watch";

    try {
      const resp = await session.customRequest("evaluate", {
        expression,
        frameId: fId,
        context: ctx,
      });
      return {
        result: resp.result,
        type: resp.type,
        variablesReference: resp.variablesReference,
        frameId: fId,
      };
    } catch (err: any) {
      if (frameId !== undefined) throw err;

      const msg = String(err?.message || "");
      if (!isNameResolutionError(msg)) throw err;

      // Cap at 5 frames to avoid excessive DAP round-trips
      const frames = await this.getStackTrace(undefined, 5, sessionId);
      for (const frame of frames) {
        if (frame.id === fId) continue;
        try {
          const resp = await session.customRequest("evaluate", {
            expression,
            frameId: frame.id,
            context: ctx,
          });
          return {
            result: resp.result,
            type: resp.type,
            variablesReference: resp.variablesReference,
            frameId: frame.id,
            resolvedFrame: {
              name: frame.name,
              file: frame.source?.path || frame.source?.name,
              line: frame.line,
            },
          };
        } catch {
          // Try next frame
        }
      }

      throw err;
    }
  }

  // ─── Wait for Stop ─────────────────────────────────────────

  waitForStop(timeoutMs?: number, sessionId?: string): Promise<StoppedEvent> {
    const timeout = timeoutMs || 30000;

    // If targeting a specific session, check if it's already paused
    if (sessionId) {
      const state = this.sessions.get(sessionId);
      if (state?.isPaused && state.lastStoppedEvent) {
        return Promise.resolve(state.lastStoppedEvent);
      }
    } else {
      // Check any paused session
      for (const state of this.sessions.values()) {
        if (state.isPaused && state.lastStoppedEvent) {
          return Promise.resolve(state.lastStoppedEvent);
        }
      }
    }

    return new Promise<StoppedEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener("stopped", onStopped);
        this.removeListener("terminated", onTerminated);
        reject(
          new Error(`Timeout: debugger did not stop within ${timeout}ms`)
        );
      }, timeout);

      const onStopped = (event: StoppedEvent) => {
        if (sessionId && event.sessionId !== sessionId) return;
        clearTimeout(timer);
        this.removeListener("stopped", onStopped);
        this.removeListener("terminated", onTerminated);
        resolve(event);
      };

      const onTerminated = (terminatedId: string) => {
        if (sessionId && terminatedId !== sessionId) return;
        clearTimeout(timer);
        this.removeListener("stopped", onStopped);
        this.removeListener("terminated", onTerminated);
        reject(new Error("Debug session terminated while waiting for stop"));
      };

      this.on("stopped", onStopped);
      this.on("terminated", onTerminated);
    });
  }
}

function isNameResolutionError(message: string): boolean {
  return /NameError|ReferenceError|not defined|is not defined|undefined variable/i.test(
    message
  );
}
