# AGENTS.md - Instructions for AI Coding Agents

## Project: Darwin

Darwin is a local home intelligence system running on Raspberry Pi 4. It uses FunctionGemma for tool dispatch and Gemma 3 1B for complex reasoning.

## Working on This Project

### Before Starting

1. Read `CLAUDE.md` for full project context
2. Check `bd ready` for available tasks
3. Understand the module architecture before making changes

### Task Management

Use Beads (`bd`) for all task tracking:

```bash
bd ready                    # See what's available
bd show <id>               # Get task details
bd update <id> --status in_progress
bd close <id> --reason "what you did"
```

If you discover new work while coding:

```bash
bd create "title" -t bug -p 1   # For bugs you find
bd create "title" -t task -p 2  # For related tasks
```

### Code Style

- TypeScript strict mode
- ESM modules with `.js` extensions in imports
- Async/await, no callbacks
- Emit events for observability
- Log appropriately (debug/info/warn/error)

### Testing Changes

```bash
npm run build              # Compile TypeScript
npm run test:health        # Verify Ollama connection
npm run test:brain         # Interactive brain testing
npm run start              # Run Darwin
```

### Git Workflow

- Create feature branch: `<task-id>-<short-description>`
- Atomic commits with conventional commit messages
- Run tests before committing
- Create PR when task complete

### Key Files

| File                             | Purpose                            |
| -------------------------------- | ---------------------------------- |
| `src/core/brain.ts`              | Dual-model AI coordinator          |
| `src/core/darwin.ts`             | Main application (was homebase.ts) |
| `src/core/module.ts`             | Module base class                  |
| `src/core/event-bus.ts`          | Inter-module communication         |
| `src/modules/code-agent.ts`      | Claude Code orchestration          |
| `src/modules/home-automation.ts` | Lights, heating, sensors           |

### Important Constraints

- **Memory**: Pi 4 has 4GB - only one Claude session at a time
- **Models**: FunctionGemma (301MB) always loaded, Gemma 1B (815MB) on demand
- **Privacy**: Everything runs locally, no cloud dependencies

### Don't

- Don't add cloud service dependencies
- Don't run multiple Claude Code sessions concurrently
- Don't leave Gemma 1B loaded unnecessarily (call `unloadReasoner()`)
- Don't ignore TypeScript errors

### Do

- Do emit events for significant actions
- Do add error handling with retries for network calls
- Do update Beads task status as you work
- Do test on actual Pi hardware when possible
