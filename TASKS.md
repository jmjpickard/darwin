# Darwin - Initial Beads Tasks

Run these commands in your Darwin repo to set up the initial task list:

```bash
# Initialize Beads
bd init

# Epic: Core Rename
bd create "Rename Homebase to Darwin throughout codebase" -t epic -p 0

# Tasks under the epic (run after getting the epic ID, e.g., bd-abc123)
bd create "Rename homebase.ts to darwin.ts and update class name" -t task -p 0
bd create "Update all imports to use Darwin instead of Homebase" -t task -p 0
bd create "Update CLI banner and messaging to say Darwin" -t task -p 0
bd create "Update package.json name and README title" -t task -p 0

# Epic: Code Quality
bd create "Fix TypeScript issues and improve error handling" -t epic -p 1

bd create "Fix process variable shadowing in code-agent.ts" -t bug -p 0
bd create "Add .js extensions to all ESM imports" -t task -p 1
bd create "Add retry logic for Ollama API calls in brain.ts" -t task -p 2
bd create "Add timeout handling for long-running Ollama generations" -t task -p 2

# Epic: Code Agent Improvements
bd create "Improve Claude Code CLI integration" -t epic -p 1

bd create "Test and fix Claude Code --print flag interaction" -t task -p 1
bd create "Add support for multi-choice questions (not just y/n)" -t task -p 2
bd create "Handle Claude Code hitting usage limit mid-task" -t task -p 1
bd create "Add progress events during Claude Code sessions" -t task -p 2

# Epic: New Features
bd create "Add notification system" -t epic -p 2

bd create "Create notifications module with Pushover/ntfy support" -t feature -p 2
bd create "Add notify_send and notify_get_pending tools" -t task -p 2
bd create "Send notification on task completion or failure" -t task -p 3

# Epic: Persistence
bd create "Add persistent storage for Darwin state" -t epic -p 2

bd create "Create storage.ts with JSON file persistence" -t task -p 2
bd create "Store completed task history" -t task -p 3
bd create "Store sensor readings over time" -t task -p 3

# Standalone tasks
bd create "Add startup self-test that verifies all tools work" -t task -p 1
bd create "Add status endpoint for potential web dashboard" -t feature -p 3
bd create "Write unit tests for Brain tool dispatch logic" -t task -p 2
```

## Priority Guide

- **P0**: Critical, do first
- **P1**: Important, do soon
- **P2**: Normal priority
- **P3**: Nice to have, do when convenient

## Viewing Tasks

```bash
bd list              # All open tasks
bd ready             # Tasks ready to work on (no blockers)
bd ready --json      # JSON format for Darwin to consume
bd dep tree <id>     # See task dependencies
```
