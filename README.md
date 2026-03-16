# IDE Code Debug Bridge

**Give your AI the power to debug like a human — visually, in real time, inside your IDE.**

IDE Code Debug Bridge is a VS Code / Cursor extension that exposes the full debugger as MCP tools. An AI running in your terminal (Claude Code, or any MCP-compatible client) can set breakpoints, start debug sessions, step through code, inspect variables, evaluate expressions — all while you watch it happen live in your editor.

No print statements. No manual reproduction. You describe the bug, the AI investigates.

---

## Why this exists

Debugging today with AI follows a frustrating loop: you paste an error, the AI guesses a fix, you test it, it's wrong, you paste more context, repeat. The AI never actually *sees* what's happening at runtime.

This extension changes that. The AI gets direct access to the debugger — the same tool you use — and can:

- **Start your application** in debug mode using your existing launch configurations
- **Place breakpoints** on exact lines without touching your source code
- **Trigger a request** (via curl, a test, whatever) and **wait for the breakpoint to hit**
- **Read every variable** in scope — locals, globals, nested objects
- **Evaluate arbitrary expressions** in the live context (`len(items)`, `response.status_code`, `user.email`)
- **Step through execution** line by line, deciding at each step whether to go deeper or continue
- **Produce a diagnosis** based on what it actually observed, not what it guessed

The developer sees all of this happening in real time — breakpoints appear, the yellow execution marker moves, variables populate the debug panel. It's like pair programming with someone who can operate the debugger at machine speed.

---

## Real-world example

> **You:** "The endpoint `/api/orders/64063` returns 404 but the order exists in the database. Debug it."

The AI:

```
1. find_code_line("routes.py", "get_order")          → line 294
2. set_breakpoints("routes.py", [294])                → breakpoint set
3. start_session("FastAPI Debug")                     → debug session running
4. [triggers: curl localhost:8000/api/orders/64063]
5. wait_for_stop()                                    → stopped at line 294
6. get_variables()                                    → order_id = "64063" (string!)
7. step_into()                                        → enters db.get_order()
8. evaluate("type(order_id)")                         → <class 'str'>
9. evaluate("self.collection.find_one({'id': 64063})")→ { ... } (found!)
10. evaluate("self.collection.find_one({'id': '64063'})")→ None
```

> **AI:** "Found it. `order_id` arrives as a string `"64063"` from the URL path, but the database stores it as an integer. The query `{'id': '64063'}` returns nothing. You need `int(order_id)` before the database call."

The entire investigation took seconds. No guessing. No back-and-forth. The AI saw the actual values at runtime and traced the exact point of failure.

---

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

## Installation

### 1. Install the extension

```bash
# Clone and build
git clone https://github.com/ygorhora/ide-code-debug.git
cd ide-code-debug
npm install
npm run build

# Package and install
npx @vscode/vsce package --allow-missing-repository
cursor --install-extension ide-code-debug-0.1.0.vsix
# or for VS Code:
code --install-extension ide-code-debug-0.1.0.vsix
```

### 2. Configure the MCP client

Add to your MCP config (e.g. `~/.claude/mcp.json` or project-level):

```json
{
  "ide-debug": {
    "type": "http",
    "url": "http://localhost:3100/mcp"
  }
}
```

### 3. Reload your editor

The extension auto-starts the MCP server on port 3100. You'll see `Debug Bridge :3100` in the status bar.

---

## MCP Tools Reference

### State & Configuration

| Tool | Description |
|------|-------------|
| `get_state` | Current debugger state: active session, paused status, file/line, stop reason |
| `get_launch_configs` | List available launch configurations from `.vscode/launch.json` |

### Session Control

| Tool | Description |
|------|-------------|
| `start_session` | Start a debug session by launch config name |
| `stop_session` | Stop the active debug session |

### Breakpoints

| Tool | Description |
|------|-------------|
| `set_breakpoints` | Set breakpoints at specific lines (supports conditional breakpoints) |
| `remove_breakpoints` | Remove breakpoints from a file (specific lines or all) |
| `list_breakpoints` | List all active breakpoints across all files |

### Code Search

| Tool | Description |
|------|-------------|
| `find_code_line` | Search for a code snippet in a file and return matching line numbers. Use before `set_breakpoints` to find the exact line. |

### Execution Control

| Tool | Description |
|------|-------------|
| `continue_execution` | Resume until next breakpoint or program end |
| `step_over` | Execute current line, stop at next line (skip function internals) |
| `step_into` | Step into the function call on the current line |
| `step_out` | Step out of the current function back to the caller |
| `pause` | Pause a running program |

### Inspection

| Tool | Description |
|------|-------------|
| `get_threads` | List all active threads |
| `get_stack_trace` | Get the call stack of a paused thread |
| `get_variables` | **Smart resolution** — automatically resolves thread → frame → scope → variables in a single call. Supports nested expansion. |
| `evaluate` | **Smart evaluation** — evaluates an expression in the debug context. If a variable isn't found in the current frame, automatically searches other frames in the call stack. |

### Synchronization

| Tool | Description |
|------|-------------|
| `wait_for_stop` | Block until the debugger pauses (breakpoint hit, step complete, exception). Returns immediately if already paused. Essential for the flow: start session → trigger request → wait for breakpoint. |

---

## Smart features

### Smart variable resolution

`get_variables` resolves the full chain automatically — you don't need to call `get_threads` → `get_stack_trace` → `get_scopes` → `get_variables` manually. One call returns everything:

```json
{
  "frame": { "name": "get_order", "file": "routes.py", "line": 294 },
  "scopes": {
    "Locals": [
      { "name": "order_id", "value": "64063", "type": "str" },
      { "name": "request", "value": "<Request>", "type": "Request",
        "children": [
          { "name": "method", "value": "GET", "type": "str" },
          { "name": "url", "value": "http://localhost:8000/api/orders/64063", "type": "URL" }
        ]
      }
    ]
  }
}
```

### Smart evaluate with frame walking

When you evaluate an expression and it fails with a `NameError` in the current frame, the extension automatically walks up the call stack to find the frame where that variable exists:

```
evaluate("request.headers")
  → Frame 0 (validate_token): NameError
  → Frame 1 (get_endpoint):   ✓ Found! Returns headers + tells you which frame resolved it
```

No need to manually inspect the stack trace and specify a `frameId`.

### Conditional breakpoints

Set breakpoints that only trigger when a condition is met:

```
set_breakpoints("routes.py", [294], condition="order_id == '64063'")
```

The debugger only pauses when `order_id` is the specific value you're investigating.

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `ideCodeDebug.port` | `3100` | Starting port for the MCP server (localhost only) |
| `ideCodeDebug.portRange` | `10` | Number of ports to scan from the base port. Set to `1` to disable auto-scanning. |
| `ideCodeDebug.portRetries` | `3` | Retry attempts per port before moving to the next one |
| `ideCodeDebug.maxRequestBodyMB` | `1` | Maximum request body size in MB. Protects the extension host from oversized payloads. |
| `ideCodeDebug.autoStart` | `true` | Auto-start the server when the editor opens |

### Multiple editor windows

Each editor window auto-starts its own MCP server. If port 3100 is already taken (by another Cursor/VS Code window, or another process), the extension automatically tries the next port in the range (3101, 3102, ...) up to `port + portRange - 1`. The status bar shows which port was actually bound.

With default settings, you can run up to 10 editor windows simultaneously (ports 3100–3109), each with its own debug bridge.

To point your MCP client at a specific window, use the port shown in that window's status bar:

```json
{
  "ide-debug": {
    "type": "http",
    "url": "http://localhost:3100/mcp"
  }
}
```

> **Tip:** If you always use a single window, set `portRange: 1` to skip scanning.

Commands (via Command Palette):

- **IDE Code Debug: Start MCP Server**
- **IDE Code Debug: Stop MCP Server**
- **IDE Code Debug: Toggle MCP Server**

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

---

## Architecture

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

## Requirements

- VS Code 1.85+ or Cursor
- An MCP-compatible client (Claude Code, or any client supporting Streamable HTTP transport)
- A debug adapter for your language (Python: debugpy, Node.js: pwa-node, etc.)

---

## License

MIT
