# Architecture

## How it works

```
┌──────────────┐    MCP (HTTP)     ┌─────────────────────┐   vscode.debug.*   ┌──────────────┐
│  Claude Code │ ←───────────────→ │  Debug Bridge       │ ←────────────────→ │  VS Code     │
│  (terminal)  │   localhost:3100  │  (extension)        │   DAP protocol     │  Debugger    │
└──────────────┘                   └─────────────────────┘                    └──────────────┘
                                          │
                                   DebugAdapterTracker
                                   intercepts DAP events
                                   (stopped, continued, etc.)
```

The extension runs an MCP server inside VS Code and translates MCP tool calls into VS Code debug API operations. A `DebugAdapterTrackerFactory` registered for all debug types (`'*'`) intercepts DAP events in real time — when the debugger hits a breakpoint, the extension knows immediately and can relay that to the AI.

This works with **any debug adapter**: Python (debugpy), Node.js, Go (delve), Rust, Java — anything VS Code can debug.

---

## Source structure

```
src/
├── extension.ts       # VS Code lifecycle, commands, status bar
├── debug-bridge.ts    # DebugAdapterTracker + vscode.debug.* wrapper + smart resolution
└── mcp-server.ts      # Streamable HTTP MCP server, per-session factory, 18 tools
```

- **Per-session MCP servers**: each client connection gets its own `McpServer` instance — no conflicts between concurrent clients
- **Idle session reaper**: abandoned sessions are cleaned up after 5 minutes
- **DebugAdapterTrackerFactory(`'*'`)**: works with every debug adapter, not just Python
- **Async throughout**: file reads use `vscode.workspace.openTextDocument`, variable expansion runs in parallel

---

## Typical debugging workflows

### Workflow 1: Endpoint debugging

```
find_code_line → set_breakpoints → start_session → [curl] → wait_for_stop → get_variables → evaluate → continue/step
```

### Workflow 2: Test failure investigation

```
set_breakpoints (at assertion) → start_session (test runner) → wait_for_stop → get_variables → evaluate (inspect state) → step_into (trace the logic)
```

### Workflow 3: Exploring unfamiliar code

```
set_breakpoints (at entry point) → start_session → wait_for_stop → get_stack_trace → get_variables (different frames) → step_into → step_over → evaluate
```
