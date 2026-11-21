# agy-pi

`agy-pi` is a lightweight CLI and Antigravity plugin built on top of the `@earendil-works/pi-coding-agent` SDK. It gives Antigravity direct access to external models connected to Pi (`~/.pi/agent`) with **zero fixed MCP token overhead** (using progressive disclosure via an Antigravity Skill), native Background Task progress on `stderr`, and reactive wakeup notifications when tasks finish.

---

## Requirements

- **Node.js**: `>= 22.19.0`
- **Pi Authentication**: Authenticated via `pi` (`/login` or configured in `~/.pi/agent/models.json`)

---

## Installation

Choose one of three installation methods:

### 1. One-line install via curl (recommended for any machine)

```bash
curl -fsSL https://raw.githubusercontent.com/mjabbur/antigravity-pi/main/scripts/install.sh | bash
```

### 2. From a local clone

```bash
git clone https://github.com/mjabbur/antigravity-pi.git
cd antigravity-pi
./scripts/install.sh
```

### 3. CLI via npm + Antigravity plugin separately

```bash
npm install -g github:mjabbur/antigravity-pi
agy plugin install https://github.com/mjabbur/antigravity-pi
```

---

## Uninstallation

If installed via `scripts/install.sh`, uninstall cleanly without touching your Pi configuration (`~/.pi`) or saved sessions:

```bash
./scripts/install.sh --uninstall
```

---

## Usage Examples

### List Available Models

```bash
agy-pi models
agy-pi models openai
agy-pi models --provider zai
```

### Quick Consultation (`ask`)

Direct LLM call via `streamSimple` (no agent loop or tools). Ideal for second opinions, code reviews, brainstorming, and synthesis:

```bash
agy-pi ask --model zai/glm-5.3:high --file src/index.ts -- "Review this file for edge cases and bottlenecks."
```

### Autonomous Agent Session (`run`)

Full agent session via `createAgentSession` (`--mode readonly` by default, or `--mode coder` to allow edits and shell execution):

```bash
agy-pi run --mode readonly --cwd . -- "Inspect the test coverage and summarize the architecture."
```

### Multi-Turn Sessions (`--session` and `sessions`)

Resume any previous `ask` or `run` session using the `session=<id>` value printed in the footer:

```bash
agy-pi sessions
agy-pi run --session <session-id> -- "Now check the auth middleware as well."
```

### JSON Output (`--json`)

Structured output for scripts and automation:

```bash
agy-pi models --json
```
