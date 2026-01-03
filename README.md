# Darwin

Local home intelligence system powered by **FunctionGemma** (dispatcher) and **Gemma 3 1B** (reasoner).

A modular, privacy-first platform that coordinates:
- **Code Agent** - Claude Code orchestration with Beads task management
- **Home Automation** - Lights, heating, sensors via Zigbee
- **Energy** - Power monitoring and optimization (coming soon)
- **Security** - Motion sensors, cameras (coming soon)

## Architecture

```
+-------------------------------------------------------------------------+
|                              DARWIN                                      |
|                                                                          |
|  +--------------------------------------------------------------------+  |
|  |                    FunctionGemma 270M (301MB)                      |  |
|  |                    "The Dispatcher" - always loaded                |  |
|  |                                                                    |  |
|  |  Receives events -> Decides which tools to call -> Executes them  |  |
|  +--------------------------------------------------------------------+  |
|                              |                                           |
|              +---------------+---------------+                           |
|              v               v               v                           |
|  +-----------------+ +-----------------+ +-----------------+             |
|  |   Code Agent    | | Home Automation | |     Energy      |             |
|  |                 | |                 | |    (planned)    |             |
|  | - Beads tasks   | | - Zigbee lights | |                 |             |
|  | - Claude Code   | | - Sensors       | | - Power monitor |             |
|  | - GitHub PRs    | | - Heating       | | - Cost tracking |             |
|  +-----------------+ +-----------------+ +-----------------+             |
|                                                                          |
|  +--------------------------------------------------------------------+  |
|  |                    Gemma 3 1B (815MB)                              |  |
|  |                    "The Reasoner" - loaded on demand               |  |
|  |                                                                    |  |
|  |  For complex decisions: code review, PR writing, task selection   |  |
|  |  Auto-unloads after 5 minutes to save RAM                         |  |
|  +--------------------------------------------------------------------+  |
|                                                                          |
|  +--------------------------------------------------------------------+  |
|  |                         Event Bus                                  |  |
|  |  Modules communicate via events, Brain observes and reacts        |  |
|  +--------------------------------------------------------------------+  |
+--------------------------------------------------------------------------+
```

## Why Two Models?

| Model | Size | Speed | Use Case |
|-------|------|-------|----------|
| **FunctionGemma 270M** | 301MB | ~20 tok/s | "What tools should I call?" |
| **Gemma 3 1B** | 815MB | ~10 tok/s | "How should I write this PR?" |

FunctionGemma is specifically trained for tool/function calling - it's fast at deciding *what* to do. Gemma 1B is better at *reasoning* - writing prose, reviewing code, making nuanced decisions.

On a Pi 4 with 4GB RAM, FunctionGemma stays resident (~500MB with Ollama), and Gemma 1B loads on demand for complex tasks.

## Quick Start

### 1. Install Prerequisites

```bash
# On your Pi 4 / Linux machine

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull the models
ollama pull functiongemma    # 301MB - dispatcher
ollama pull gemma3:1b        # 815MB - reasoner (optional but recommended)

# Install CLI tools (for Code Agent)
npm install -g @anthropic-ai/claude-code
claude login

sudo apt install gh
gh auth login

curl -fsSL https://raw.githubusercontent.com/steveyegge/beads/main/scripts/install.sh | bash
```

### 2. Install Darwin

```bash
git clone https://github.com/you/darwin
cd darwin
npm install
```

### 3. Run Health Check

```bash
npm run test:health
```

Expected output:
```
Darwin Health Check

1. Checking Ollama...
   OK Running

2. Checking models...
   OK FunctionGemma (dispatcher): Available
   OK Gemma 3 1B (reasoner): Available

3. Testing FunctionGemma...
   OK Response: "ready"

4. Checking CLI tools...
   OK Claude Code CLI: Installed
   OK Beads CLI: Installed
   OK GitHub CLI: Installed

OK Health check: 7/7 checks passed
```

### 4. Start Darwin

```bash
# Basic start (mock home automation)
npm run start

# With your code repo
npm run start -- --repo /path/to/your/project

# Auto-start Code Agent when capacity available
npm run start -- --repo /path/to/project --auto

# Debug mode
npm run start -- --log debug
```

### 5. Test the Brain

```bash
npm run test:brain
```

Try these inputs:
```
> It's 11pm, no motion for 30 minutes
[FunctionGemma calls: home_scene("bedtime")]

> Claude Code finished the authentication task
[FunctionGemma calls: code_get_ready_tasks()]

> reason: Should I prioritize the memory leak bug or the new feature?
[Gemma 1B reasons about priorities]
```

## Registered Tools

### Code Agent

| Tool | Description |
|------|-------------|
| `code_get_ready_tasks` | Get tasks ready to work on from Beads |
| `code_start_task` | Start Claude Code on a specific task |
| `code_get_status` | Get agent status (capacity, active task) |
| `code_stop_task` | Stop current Claude session |
| `code_check_capacity` | Check Claude Code usage limits |

### Home Automation

| Tool | Description |
|------|-------------|
| `home_lights_set` | Control lights (room, brightness, color) |
| `home_heating_set` | Set heating temperature |
| `home_get_sensors` | Get sensor readings |
| `home_get_motion` | Get recent motion events |
| `home_scene` | Trigger scene (bedtime, morning, movie, away, home) |

## Event Flow Example

```
Motion sensor -> Event Bus -> FunctionGemma
                               |
                    "Motion in kitchen at 7am"
                               |
                    Calls: home_lights_set(kitchen, 80)
                           home_heating_set(all, 20)
                               |
                    Lights turn on, heating adjusts
```

## Configuration

### Environment Variables

```bash
OLLAMA_URL=http://localhost:11434   # Ollama API URL
LOG_LEVEL=info                      # debug, info, warn, error
```

### Module Config

```typescript
const darwin = new Darwin();

darwin
  .use(CodeAgentModule, {
    enabled: true,
    repoPath: '/path/to/your/project',
    autoStart: true,              // Start tasks automatically
    usageThreshold: 80,           // Don't start if Claude >80% used
    maxSessionMinutes: 30,        // Max time per task
    testCommand: 'npm test',      // Command to verify changes
  })
  .use(HomeAutomationModule, {
    enabled: true,
    mockMode: false,              // Set false for real devices
    zigbee2mqttUrl: 'mqtt://localhost:1883',
  });

await darwin.start();
```

## Adding a New Module

```typescript
import { DarwinModule, ModuleConfig } from 'darwin';

export class MyModule extends DarwinModule {
  readonly name = 'MyModule';
  readonly description = 'Does something cool';

  async init(): Promise<void> {
    // Register tools with the Brain
    this.registerTool(
      'my_action',
      'Description of what it does',
      {
        type: 'object',
        properties: {
          param1: { type: 'string', description: 'A parameter' },
        },
        required: ['param1'],
      },
      async (args) => {
        // Do the thing
        return { success: true };
      }
    );
  }

  async start(): Promise<void> {
    this._enabled = true;
  }

  async stop(): Promise<void> {
    this._enabled = false;
  }
}
```

## Hardware Requirements

| Setup | RAM | Notes |
|-------|-----|-------|
| **Minimum** | 4GB | FunctionGemma only, one Claude session |
| **Recommended** | 8GB | Both models, comfortable headroom |
| **Ideal** | 16GB+ | Multiple concurrent agents, larger models |

Works on:
- Raspberry Pi 4 (4GB+)
- Old laptops/mini PCs
- Any Linux server

## Roadmap

- [x] Core Brain (FunctionGemma + Gemma 1B)
- [x] Module system
- [x] Event bus
- [x] Code Agent module
- [x] Home Automation module (mock)
- [ ] Real Zigbee integration (zigbee2mqtt)
- [ ] Energy monitoring module
- [ ] Security module
- [ ] Web dashboard (T3 stack)
- [ ] Mobile notifications
- [ ] Voice input (Whisper)

## Privacy

Everything runs locally:
- No cloud dependencies
- Your data stays on your hardware
- Models run on-device via Ollama
- You control what gets shared

## License

MIT
