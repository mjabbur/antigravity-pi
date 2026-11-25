# agy-pi

`agy-pi` is a lightweight CLI and Antigravity plugin built on top of the `@earendil-works/pi-coding-agent` SDK. It gives Antigravity direct access to external models connected to Pi (`~/.pi/agent`) with **zero fixed MCP token overhead** (using progressive disclosure via an Antigravity Skill), native Background Task progress on `stderr`, reactive wakeup notifications when tasks finish, and full subagent parity.

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

You can optionally pin to a specific git tag or commit SHA using `AGY_PI_REF`:

```bash
AGY_PI_REF=v1.0.0 curl -fsSL https://raw.githubusercontent.com/mjabbur/antigravity-pi/main/scripts/install.sh | bash
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

## Security Model

- `agy-pi` runs with `projectTrusted: false` and a literal resource loader by default, ensuring untrusted repositories cannot trigger package installation, load `.pi/extensions`, or inject local files as system prompts.
- `--project-agents` is strictly opt-in, stops traversal at the repository root, rejects symlinks, and never silently shadows user profiles located in `~/.pi/agent/agents/`.
- `--workspace worktree` isolates Git edits on a dedicated branch (`agy-pi/<name>`), **not** the operating system: Pi's built-in tools (`read`, `bash`, etc.) run with the invoking user's OS permissions. For untrusted repositories, execute inside a container or sandboxed VM.

---

## Uninstallation

If installed via `scripts/install.sh`, uninstall cleanly without touching your Pi configuration (`~/.pi`) or saved sessions:

```bash
./scripts/install.sh --uninstall
```

---

## Usage Examples

### List Available Models & Agent Profiles

```bash
agy-pi models
agy-pi models anthropic
agy-pi agents
agy-pi agents --project-agents
```

#### Declarative Agent Profiles
Create reusable agent profiles in `~/.pi/agent/agents/*.md` (or project-level):
```markdown
---
name: code-reviewer
description: Expert security and code quality reviewer
model: zai/glm-5.3:high
tools: [read, grep, find, ls]
workspace: inherit
---

You are an expert senior code reviewer. Focus on robustness, security vulnerabilities, and edge cases.
```

### Quick Consultation (`ask`)

Direct LLM call via `streamSimple` (no agent loop or tools):

```bash
agy-pi ask --model zai/glm-5.3:high --file src/index.ts -- "Review this file for edge cases and bottlenecks."
```

### Subagent Lifecycle & Execution (`run`, `send`, `ls`, `diff`, `kill`)

Run autonomous agent sessions with full background task parity, isolated git worktrees, and persistent state:

1. **Start an agent**:
   ```bash
   agy-pi run --name reviewer --agent code-reviewer --workspace worktree -- "Audit auth/jwt.ts for vulnerabilities."
   ```
2. **List active sessions**:
   ```bash
   agy-pi ls
   ```
3. **Inspect changes**:
   ```bash
   agy-pi diff reviewer
   ```
4. **Send follow-up instructions**:
   ```bash
   agy-pi send reviewer -- "Also check the refresh token expiration logic."
   ```
5. **Terminate and cleanup**:
   ```bash
   agy-pi kill reviewer --delete-branch
   ```

### Using `agy-pi` with `/swarm`

- Inside `/swarm` workers that already have `workspace: "share"`, use `--workspace inherit` so each subagent operates within the shared workspace without git conflicts.
- Alternatively, fan out parallel independent writers using `agy-pi run --workspace worktree` directly from the coordinator.
