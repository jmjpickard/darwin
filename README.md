# Darwin

Local home intelligence system that runs on a Raspberry Pi and keeps everything on-device.
Darwin can use a local Ollama model or OpenRouter for chat and tool calling
for deep reasoning.

Darwin coordinates:

- Code Agent - Claude Code orchestration with Beads task management
- Home Automation - Lights, heating, sensors (mock today, Zigbee later)
- Proactive assistant loop - Consciousness ticks and a visible monologue
- Web search + page fetch - DuckDuckGo HTML search

## Current Architecture

```
+------------------------------------------------------------------+
|                              DARWIN                              |
|                                                                  |
|  +-----------------------------+   +---------------------------+  |
|  |        Monologue            |   |       Consciousness       |  |
|  |  Thought stream + logging   |   |  Proactive tick loop      |  |
|  +-----------------------------+   +---------------------------+  |
|                 |                             |                  |
|                 +------------+----------------+                  |
|                              v                                   |
|  +----------------------------------------------------------------+|
|  |                 Brain (Configurable provider)                   ||
|  |  - Tool calling and chat                                       ||
|  |  - Terminal observation for Claude Code                        ||
|  +----------------------------------------------------------------+|
|                              |                                   |
|         +--------------------+--------------------+              |
|         v                    v                    v              |
|  +---------------+   +----------------+   +------------------+   |
|  | Code Agent    |   | Home Automation|   | Web Search /      |   |
|  | (Claude Code) |   | (mock now)     |   | OpenRouter (opt)  |   |
|  +---------------+   +----------------+   +------------------+   |
|                                                                  |
|  +--------------------------------------------------------------+|
|  |                        Event Bus                             ||
|  +--------------------------------------------------------------+|
+------------------------------------------------------------------+
```

## Models

- Local model: `llama3.2:1b` via Ollama (default)
- Optional: OpenRouter provider for Pi-friendly remote inference
- Optional: OpenRouter for DeepSeek R1 (`deepseek/deepseek-r1`) to power `think_deep` and `research`

## Quick Start (Pi 4, headless)

### 1. System prerequisites

```bash
sudo apt-get update
sudo apt-get install -y git build-essential python3
```

### 2. Install Node.js (20+)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 3. Install Ollama + pull the model

```bash
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl enable --now ollama

ollama pull llama3.2:1b
```

Darwin will also attempt to pull the configured model on startup if it's missing.

### 4. Install CLI tools (only if using Code Agent)

```bash
npm install -g @anthropic-ai/claude-code
claude login

sudo apt-get install -y gh

gh auth login

curl -fsSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash

# Optional: Codex CLI (ARM64)
npm install -g @openai/codex
# Follow Codex CLI auth/setup prompts after install
```

If you plan to use the Codex backend, install the Codex CLI on the Pi and authenticate.
Ensure the `codex` command is on your PATH (you can override the command in `codeAgent.agentCommands`).

### 5. Install Darwin

```bash
git clone https://github.com/you/darwin
cd darwin
npm install
```

### 6. Create config file

Running Darwin once will create a template config at `~/.darwin/config.json`:

```bash
npm run start -- --auto
```

Then edit the file and restart. See [Configuration Reference](#configuration-reference) below for full details.

### 7. Run Darwin

```bash
# Interactive REPL (shows thought stream)
npm run start

# Headless daemon (no prompt, auto-start tasks)
npm run start -- --auto

# Debug logging
npm run start -- --log debug
```

## Interactive REPL

The REPL streams Darwin's monologue while you type. Built-in commands:

- `help` - show available commands
- `status` - show module and tool status
- `tasks` - list ready Beads tasks
- `pause` / `resume` - stop or resume picking up new tasks
- `attach` - watch live Claude output (Ctrl+C to detach)
- `thoughts` - recent monologue entries
- `logs` - recent event bus activity
- `mute` / `unmute` - toggle monologue stream
- `clear` - reset chat history
- `quit` - exit

## Monologue and Consciousness

- Monologue log file: `~/.darwin/monologue.log`
- Consciousness tick interval and idle thoughts are configured in `~/.darwin/config.json`

## Registered Tools

### Code Agent

- `code_get_ready_tasks`
- `code_list_tasks`
- `code_show_task`
- `code_start_task`
- `code_get_status`
- `code_stop_task`
- `code_check_capacity`
- `code_add_task`
- `code_update_task`
- `code_close_task`
- `code_list_repos`

### Home Automation

- `home_lights_set`
- `home_heating_set`
- `home_get_sensors`
- `home_get_motion`
- `home_scene`

### Web + Research

- `web_search` (DuckDuckGo)
- `web_fetch`
- `think_deep` (OpenRouter, optional)
- `research` (OpenRouter, optional)

## Configuration Reference

Darwin is configured via `~/.darwin/config.json`. Running Darwin for the first time creates a template.

### Full Example

```json
{
  "repos": [
    {
      "path": "/path/to/your/project",
      "name": "my-project",
      "enabled": true,
      "testCommand": "npm test",
      "typecheckCommand": "npm run build",
      "sshUrl": "git@github.com:user/my-project.git",
      "defaultBranch": "main",
      "description": "My project for overnight tasks"
    }
  ],
  "defaults": {
    "testCommand": "npm test",
    "typecheckCommand": "npm run build",
    "checkIntervalMs": 300000,
    "maxSessionMinutes": 30,
    "usageThreshold": 80
  },
  "brain": {
    "provider": "ollama",
    "model": "llama3.2:1b",
    "timeoutMs": 60000
  },
  "consciousness": {
    "tickIntervalMs": 30000,
    "idleThinkingEnabled": true
  },
  "openrouter": {
    "apiKey": "sk-or-...",
    "defaultModel": "deepseek/deepseek-r1"
  },
  "webSearch": {
    "enabled": true,
    "maxResults": 5
  },
  "codeAgent": {
    "agent": "claude",
    "agentCommands": {
      "claude": { "command": "claude", "args": [] },
      "codex": { "command": "codex", "args": [] }
    }
  },
  "gitSync": {
    "enabled": false,
    "intervalMs": 300000,
    "prdReposOnly": true,
    "autoStash": false
  }
}
```

### repos

Array of repositories Darwin can work with.

| Field              | Type    | Required | Default         | Description                                                                   |
| ------------------ | ------- | -------- | --------------- | ----------------------------------------------------------------------------- |
| `path`             | string  | Yes      | -               | Local filesystem path to the repo                                             |
| `name`             | string  | No       | directory name  | Display name for the repo                                                     |
| `enabled`          | boolean | No       | `true`          | Whether Darwin should work with this repo                                     |
| `testCommand`      | string  | No       | from `defaults` | Command to run tests                                                          |
| `typecheckCommand` | string  | No       | from `defaults` | Command to run type checking                                                  |
| `sshUrl`           | string  | No       | -               | SSH clone URL for workspace-based tasks (e.g. `git@github.com:user/repo.git`) |
| `defaultBranch`    | string  | No       | `"main"`        | Branch to clone when using SSH workspaces                                     |
| `description`      | string  | No       | -               | Context about the repo for Brain/prompts                                      |

### defaults

Default values used across all repos unless overridden.

| Field               | Type   | Default           | Description                          |
| ------------------- | ------ | ----------------- | ------------------------------------ |
| `testCommand`       | string | `"npm test"`      | Default test command                 |
| `typecheckCommand`  | string | `"npm run build"` | Default typecheck command            |
| `checkIntervalMs`   | number | `300000` (5 min)  | How often to check for new tasks     |
| `maxSessionMinutes` | number | `30`              | Max time for a single coding session |
| `usageThreshold`    | number | `80`              | Usage percentage to trigger warnings |

### brain

Configure the AI brain provider and model.

| Field       | Type                         | Default         | Description                      |
| ----------- | ---------------------------- | --------------- | -------------------------------- |
| `provider`  | `"ollama"` \| `"openrouter"` | `"ollama"`      | Which provider to use            |
| `model`     | string                       | `"llama3.2:1b"` | Model name for the provider      |
| `timeoutMs` | number                       | `60000`         | Timeout for brain requests in ms |

### consciousness

Configure the proactive thinking loop.

| Field                 | Type    | Default | Description                                  |
| --------------------- | ------- | ------- | -------------------------------------------- |
| `tickIntervalMs`      | number  | `30000` | How often Darwin "thinks" in ms              |
| `idleThinkingEnabled` | boolean | `true`  | Emit idle thoughts when nothing is happening |

### openrouter

OpenRouter configuration for remote model access (DeepSeek R1, etc).

| Field          | Type   | Default                  | Description                                         |
| -------------- | ------ | ------------------------ | --------------------------------------------------- |
| `apiKey`       | string | -                        | Your OpenRouter API key                             |
| `defaultModel` | string | `"deepseek/deepseek-r1"` | Default model for `think_deep` and `research` tools |

### webSearch

DuckDuckGo web search configuration.

| Field        | Type    | Default | Description                |
| ------------ | ------- | ------- | -------------------------- |
| `enabled`    | boolean | `true`  | Enable web search tools    |
| `maxResults` | number  | `5`     | Maximum results per search |

### codeAgent

Configure the code agent backend (Claude Code or Codex).

| Field           | Type                    | Default    | Description                       |
| --------------- | ----------------------- | ---------- | --------------------------------- |
| `agent`         | `"claude"` \| `"codex"` | `"claude"` | Which agent backend to use        |
| `agentCommands` | object                  | -          | Override CLI commands (see below) |

**agentCommands** allows you to customize the CLI commands:

```json
{
  "agentCommands": {
    "claude": {
      "command": "claude",
      "args": ["--dangerously-skip-permissions"]
    },
    "codex": { "command": "/custom/path/codex", "args": [] }
  }
}
```

### gitSync

Automatic git pull for repositories.

| Field          | Type    | Default          | Description                          |
| -------------- | ------- | ---------------- | ------------------------------------ |
| `enabled`      | boolean | `false`          | Enable automatic git pulls           |
| `intervalMs`   | number  | `300000` (5 min) | Interval between pulls               |
| `prdReposOnly` | boolean | `true`           | Only sync repos that have `prd.json` |
| `autoStash`    | boolean | `false`          | Auto-stash local changes before pull |

### Environment Variables

```bash
DARWIN_CONFIG_DIR=~/.darwin
DARWIN_TERMINAL_BACKEND=pty|proxy
DARWIN_TERMINAL_PROXY_SOCKET=~/.darwin/terminald.sock
DARWIN_TERMINAL_PROXY_TOKEN=
DARWIN_TERMINAL_PROXY_TIMEOUT_MS=5000
DARWIN_TERMINAL_PROXY_SANITIZE_ENV=0
DARWIN_TERMINAL_PROXY_MINIMAL_ENV=0
```

### Terminal Proxy (Sandboxed Environments)

If you need Darwin to control a PTY from inside a sandboxed environment
(e.g. Claude Code/Codex), run the proxy daemon outside the sandbox and
point Darwin at its socket:

```bash
# Outside the sandbox
npm run terminald

# Inside the sandbox
export DARWIN_TERMINAL_BACKEND=proxy
npm run start
```

## Testing

```bash
npm run build
npm run test:health
npm run test:brain
```

## Hardware Notes

- Raspberry Pi 4 (4GB) is supported for Llama 3.2 1B
- OpenRouter calls use network access and are optional
- Only one Claude Code session at a time to avoid memory spikes

## Roadmap

- [x] Llama 3.2 1B brain via Ollama
- [x] OpenRouter brain provider for Pi-friendly inference
- [x] Monologue and proactive consciousness loop
- [x] Code Agent with PTY control
- [x] Web search + OpenRouter integration
- [ ] Real Zigbee integration (zigbee2mqtt)
- [ ] Energy monitoring module
- [ ] Notifications module
- [ ] Web dashboard

## Privacy

Everything runs locally by default:

- No cloud dependencies required
- Data stays on your hardware
- Optional OpenRouter usage is opt-in

## License

MIT
