# CLAUDE.md - Darwin Implementation Guide

## Project Overview

**Darwin** is a local home intelligence system that runs on a Raspberry Pi 4 (4GB). It uses a dual-model AI architecture:

- **FunctionGemma 270M** ("The Dispatcher") - Always loaded, decides which tools to call
- **Gemma 3 1B** ("The Reasoner") - Loaded on demand for complex decisions, auto-unloads after 5 mins

Darwin coordinates:

1. **Code Agent** - Orchestrates Claude Code to work through Beads tasks overnight
2. **Home Automation** - Controls lights, heating, sensors via Zigbee (future: zigbee2mqtt)
3. **Energy Monitoring** - Track power usage (planned)
4. **Security** - Motion sensors, alerts (planned)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                           DARWIN                                 │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              FunctionGemma 270M (Dispatcher)               │  │
│  │  - Receives events from modules                           │  │
│  │  - Decides which tools to call                            │  │
│  │  - Fast: ~20 tokens/sec on Pi 4                           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│              Tools registered by modules                        │
│              ┌───────────────┼───────────────┐                  │
│              ▼               ▼               ▼                  │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐   │
│  │   CodeAgent     │ │ HomeAutomation  │ │    (Future)     │   │
│  │   Module        │ │    Module       │ │    Modules      │   │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘   │
│                              │                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                  Event Bus                                 │  │
│  │  - Modules publish events                                 │  │
│  │  - Brain observes and can react                           │  │
│  │  - History kept for context                               │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              Gemma 3 1B (Reasoner)                         │  │
│  │  - Loaded on demand for complex tasks                     │  │
│  │  - PR descriptions, code review, task prioritization      │  │
│  │  - Auto-unloads after 5 mins idle                         │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Current File Structure

```
darwin/
├── src/
│   ├── index.ts              # Main exports
│   ├── core/
│   │   ├── brain.ts          # Dual-model AI coordinator
│   │   ├── homebase.ts       # Main app (RENAME TO darwin.ts)
│   │   ├── module.ts         # Module base class & loader
│   │   ├── event-bus.ts      # Inter-module communication
│   │   └── logger.ts         # Logging utility
│   ├── modules/
│   │   ├── code-agent.ts     # Claude Code + Beads orchestration
│   │   └── home-automation.ts # Lights, heating, sensors
│   └── cli/
│       ├── start.ts          # Main entry point
│       ├── test-brain.ts     # Interactive brain testing
│       └── health-check.ts   # Verify Ollama & models
├── package.json
├── tsconfig.json
└── README.md
```

## Immediate Tasks

### 1. Rename from "Homebase" to "Darwin"

Files to update:

- `src/core/homebase.ts` → `src/core/darwin.ts`
- Update class name `Homebase` → `Darwin`
- Update all imports and references
- Update `src/index.ts` exports
- Update `src/cli/start.ts` banner and references
- Update `README.md`
- Update `package.json` name field

### 2. Fix TypeScript Issues

The current code has some issues that need fixing:

- In `code-agent.ts`, `process` variable shadows Node's global `process`
- Ensure all imports use `.js` extensions for ESM compatibility
- Add proper error handling for fetch calls
- Fix the `ChildProcess` type imports

### 3. Add Missing Core Functionality

**In `brain.ts`:**

- Add retry logic for Ollama calls (network can be flaky on Pi)
- Add timeout handling for long-running generations
- Add metrics/logging for tool call success rates

**In `code-agent.ts`:**

- The Claude Code CLI interaction needs testing - the `--print` flag behaviour may vary
- Add support for detecting when Claude is asking multi-choice questions (not just y/n)
- Handle the case where Claude Code hits its usage limit mid-task
- Add progress events so we can track what's happening

**In `darwin.ts` (currently homebase.ts):**

- Add a status endpoint for potential web dashboard
- Add graceful handling of Ollama not being available
- Add startup self-test that verifies all tools work

### 4. Improve Home Automation Module

Currently mock-only. Add:

- Configuration for zigbee2mqtt MQTT broker connection
- Device discovery and mapping
- Real sensor event handling
- Scene definitions stored in config file

### 5. Add Notification Module

Create `src/modules/notifications.ts`:

- Support for Pushover, ntfy.sh, or Telegram
- Tools: `notify_send`, `notify_get_pending`
- Used for: escalations, morning summaries, alerts

### 6. Add Persistence

Create `src/core/storage.ts`:

- Simple JSON file storage for:
  - Completed task history
  - Sensor readings over time
  - Configuration
- Location: `~/.darwin/` or configurable

## Technical Details

### Ollama API

FunctionGemma uses the chat endpoint with tools:

```typescript
POST http://localhost:11434/api/chat
{
  "model": "functiongemma",
  "messages": [{ "role": "user", "content": "..." }],
  "tools": [...],
  "stream": false
}
```

Gemma 1B uses the generate endpoint:

```typescript
POST http://localhost:11434/api/generate
{
  "model": "gemma3:1b",
  "prompt": "...",
  "stream": false,
  "options": { "num_predict": 200 }
}
```

To unload a model (free RAM):

```typescript
POST http://localhost:11434/api/generate
{
  "model": "gemma3:1b",
  "prompt": "",
  "keep_alive": 0
}
```

### Claude Code CLI

Current approach uses `--print` flag:

```bash
claude --print -p "your prompt here"
```

Questions from Claude appear in stdout with patterns like:

- `? [y/n]`
- `Should I...`
- `Do you want...`

Responses are piped to stdin.

**Note:** This may need adjustment based on actual Claude Code CLI behaviour. Test thoroughly.

### Beads CLI

```bash
bd ready --json          # Get tasks ready to work on
bd show <id> --json      # Get task details
bd update <id> --status in_progress
bd close <id> --reason "summary"
bd create "title" -t task -p 1
```

### Event Bus Patterns

Modules publish events:

```typescript
eventBus.publish("code", "task_completed", { taskId: "bd-abc123" });
eventBus.publish("home", "motion", { room: "kitchen" });
```

Brain observes and dispatches:

```typescript
// Events matching these patterns trigger Brain dispatch
/^home:motion:/
/^code:task_completed/
/^energy:power_spike/
```

## Testing Strategy

1. **Unit tests for Brain:**

   - Mock Ollama responses
   - Verify correct tools are called for scenarios

2. **Integration test for Code Agent:**

   - Create a test Beads task
   - Verify branch creation, commits, PR flow
   - Use a test repo, not production

3. **Manual testing:**
   - `npm run test:brain` - Interactive tool calling
   - `npm run test:health` - Verify dependencies

## Hardware Constraints (Pi 4, 4GB)

- FunctionGemma resident: ~500MB with Ollama
- Gemma 1B when loaded: +800MB
- Claude Code CLI: ~300MB per instance
- **Run ONE Claude session at a time**
- Unload Gemma 1B when not needed

## Dependencies

```json
{
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.7.0",
    "typescript": "^5.7.0"
  }
}
```

No runtime dependencies - uses native Node.js fetch, child_process, etc.

## Commands

```bash
npm install           # Install deps
npm run build         # Compile TypeScript
npm run start         # Run Darwin
npm run test:brain    # Interactive brain testing
npm run test:health   # Check Ollama & models
```

## Configuration

Environment variables:

```bash
OLLAMA_URL=http://localhost:11434
LOG_LEVEL=info|debug|warn|error
DARWIN_CONFIG_DIR=~/.darwin
```

## Future Modules (Planned)

1. **Energy** - Shelly EM integration, power tracking
2. **Security** - PIR sensors (reuse old alarm sensors), camera integration
3. **Calendar** - Family schedule coordination
4. **Health** - Sleep tracking, air quality (CO2 sensors)

## Code Style

- TypeScript strict mode
- ESM modules (use `.js` in imports)
- Async/await throughout
- Emit events for observability
- Log at appropriate levels (debug for verbose, info for actions, warn/error for problems)

## Owner Context

Jack is head of engineering at Hertility Health, has a PhD in molecular cardiology from UCL. He values:

- Privacy and digital sovereignty (local-first)
- Clean, well-documented code
- Systems that work reliably overnight without intervention
- Building tools rather than buying SaaS

Darwin runs on his Raspberry Pi 4 and orchestrates Claude Code to work through his personal project tasks while he sleeps.
