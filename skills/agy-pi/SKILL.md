---
name: agy-pi
description: Use agy-pi CLI to consult or delegate work to external LLM models connected to Pi (~/.pi/agent) with zero fixed MCP token overhead and native subagent parity.
---

# agy-pi Skill

Treat `agy-pi` subagents transparently just like native Antigravity subagents.

## Core Rules

1. **Standalone Sandbox Bypass**: Always run `agy-pi` with `BypassSandbox: true` as a pure, standalone command (no `&&`, `;`, `$VAR`, `$(...)`) so user terminal approval auto-allows it.
2. **Discovery & Management (Synchronous)**: Run with `WaitMsBeforeAsync: 5000` for discovery and management: `agy-pi models [filter]`, `agy-pi agents`, `agy-pi ls`, `agy-pi diff <name>`, `agy-pi kill <name|--all>`.
3. **Execution & Interaction (Background)**: Run with `WaitMsBeforeAsync: 500` for execution: `agy-pi ask`, `agy-pi run`, `agy-pi send` — runs as native Antigravity Background Tasks with live stderr progress and reactive wakeup on completion. Never poll or sleep. Fan out multiple parallel calls in the same turn when useful.

---

## Commands & Usage

### 1. Discovery & Agents
- `agy-pi models [filter]` — list available models
- `agy-pi agents [--project-agents]` — list declarative agent profiles (`~/.pi/agent/agents/*.md`)

### 2. Direct Query (`agy-pi ask`)
Fast direct LLM call (no tools):
```bash
agy-pi ask --model provider/id[:thinking] --file <path>... --session <id> -- "<prompt>"
```

### 3. Agent Execution (`agy-pi run`)
Full autonomous subagent session:
```bash
agy-pi run [--name <alias>] [--agent <profile>] [--model <m>] [--mode readonly|coder] [--tools <list>] [--workspace inherit|worktree] [--cwd <dir>] [--file <path>]... -- "<task>"
```
- Default workspace is `inherit` (always keep `inherit` inside a `/swarm` worker that has `workspace: "share"`).
- Use `--workspace worktree` when running parallel writers/coders directly from the same repo so each subagent gets an isolated git worktree & branch (`agy-pi/<name>`).

### 4. Session Continuation (`agy-pi send`)
Continue an active session (equivalent to `send_message`):
```bash
agy-pi send <name|id> [--file <path>]... -- "<follow-up>"
```

### 5. Lifecycle Management
- `agy-pi ls` — list active managed subagent sessions
- `agy-pi diff <name|id>` — show git diff for a session's workspace
- `agy-pi kill <name|id|--all>` [--force] [--delete-branch] — terminate sessions and clean up worktrees
