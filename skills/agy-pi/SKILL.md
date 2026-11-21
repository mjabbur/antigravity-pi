---
name: agy-pi
description: Use agy-pi CLI to consult or delegate work to external LLM models connected to Pi (~/.pi/agent) with zero fixed MCP token overhead.
---

# agy-pi Skill

Use `agy-pi` to consult, review, or delegate work to external LLM models (Claude, GPT, DeepSeek, Gemini, etc.) connected to Pi (`~/.pi/agent`).

## Core Rules

1. **Standalone Sandbox Bypass**: Always run `agy-pi` with `BypassSandbox: true` as a pure, standalone command (no shell chaining like `&&`, `;`, variables `$VAR`, or command substitutions `$(...)`) so user terminal approval auto-allows it.
2. **Model Discovery**: Run `agy-pi models [filter]` synchronously (`WaitMsBeforeAsync: 5000`) to find available model IDs.
3. **Background Tasks**: Run `agy-pi ask` and `agy-pi run` with `WaitMsBeforeAsync: 500` (backgrounded) so they run as native Antigravity Background Tasks with live progress and reactive wakeup on completion. **Never poll or sleep.**

---

## Commands & Usage

### 1. Discover Models
```bash
agy-pi models
agy-pi models anthropic
```

### 2. Quick Consult (`agy-pi ask`)
Fast direct LLM call (no agent loop/tools). Ideal for second opinions, code reviews, brainstorming, or synthesis.
- `--model provider/id[:thinking]` (e.g., `--model zai/glm-5.3:high`)
- `--file <path>` (repeatable, attaches files as context)
- `--session <id>` (resume/continue a session)

```bash
agy-pi ask --model zai/glm-5.3:high --file src/index.ts -- "Review this file for security issues."
```

### 3. Agent Execution (`agy-pi run`)
Full autonomous agent session for exploring codebases, running tests, or editing files.
- `--mode readonly` (default: `read,grep,find,ls`) vs `--mode coder` (can write/edit/run bash)
- `--cwd <dir>`
- `--session <id>`

> [!WARNING]
> Never run two `coder` mode agents in the same working tree simultaneously.

```bash
agy-pi run --mode readonly --cwd /path/to/repo -- "Analyze the architecture of src/core.ts."
```

### 4. Multi-Turn Sessions
Check the `[agy-pi] session=<id>` footer in output, then pass `--session <id>` for follow-ups. List recent sessions with `agy-pi sessions`.
