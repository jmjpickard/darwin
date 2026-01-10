#!/bin/bash
# ralph.sh - The Ralph Wiggum Method
# "I'm helping!" - Ralph Wiggum
#
# A simple loop that runs Claude Code iterations until all PRD items pass.
# Each iteration picks one failing item, implements it, tests it, and commits.
# Falls back to Codex if rate limited.
#
# Workflow:
# - Creates a feature branch at the start (ralph/<timestamp>)
# - Each task commits to the branch
# - If ANY task fails, the whole run fails (human in the loop needed)
# - Detailed progress logged to progress.txt
#
# Cost controls:
# - 5 minute timeout per iteration
# - Prompt instructs Claude to stop after ~20 tool calls

set -e

MAX_ITERATIONS=${1:-10}
ITERATION=0
TIMEOUT_SECONDS=300  # 5 minutes

# Agent preference order
AGENTS=("claude" "codex")

# Create feature branch name
BRANCH_NAME="ralph/$(date +%Y%m%d-%H%M%S)"

# Initialize progress.txt
echo "# Ralph Progress Log" > progress.txt
echo "Started: $(date)" >> progress.txt
echo "Branch: $BRANCH_NAME" >> progress.txt
echo "Max iterations: $MAX_ITERATIONS" >> progress.txt
echo "" >> progress.txt

echo "=== Ralph Wiggum Method ==="
echo "Branch: $BRANCH_NAME"
echo "Max iterations: $MAX_ITERATIONS"
echo "Timeout: ${TIMEOUT_SECONDS}s per iteration"
echo ""

# Track which agents are rate limited (with timestamp for 5hr window)
declare -A RATE_LIMITED_UNTIL

PROMPT='@prd.json @progress.txt

SETUP (first iteration only):
- Check if you are on a branch starting with "ralph/". If not, checkout to: '"$BRANCH_NAME"'
- Log to progress.txt: "Checked out branch: '"$BRANCH_NAME"'"

CONSTRAINTS:
- You have MAX 20 tool calls. If you are approaching the limit, STOP immediately.
- DO NOT explore the codebase extensively. Only read files directly mentioned in the task.
- Try ONE approach. If it fails, STOP - do not try multiple alternatives.
- Be efficient. Delete files directly, do not read them first.

PROGRESS TRACKING:
Append detailed progress to progress.txt after EVERY significant action:
  [YYYY-MM-DD HH:MM:SS] ACTION: detailed description

Log these events:
  - BRANCH: checked out or confirmed branch
  - EVALUATE: assessed tasks and chose one with reasoning
  - READ: what file and what you learned
  - DELETE: file deleted
  - EDIT: file edited and summary of changes
  - BUILD: npm run build started
  - BUILD_PASS: build succeeded
  - BUILD_FAIL: build failed with specific error
  - COMMIT: commit message
  - TASK_COMPLETE: task finished successfully
  - TASK_FAIL: task failed with reason
  - STUCK: cannot proceed, reason

TASK:
1. Review ALL items in prd.json with passes:false
2. Evaluate which task to do FIRST based on:
   - Dependencies: does one task depend on another being done first?
   - Risk: features before refactors, refactors before cleanup
   - Build impact: will this task break the build until another is done?
3. Log: "[timestamp] EVALUATE: Chose [category] - [description] because [reasoning]"
4. Execute the action described in that item
5. Run: npm run build
6. If build passes:
   - Update prd.json to set passes:true for this item
   - Commit all changes with message: "ralph: [category] - [description]"
   - Log: "[timestamp] TASK_COMPLETE: [description]"
   - Output: <done>description</done>
7. If build fails:
   - Log: "[timestamp] TASK_FAIL: [specific error message]"
   - Output: <stuck>specific error description</stuck>
   - DO NOT try to fix it, just stop

If ALL items in prd.json have passes:true:
  - Log: "[timestamp] ALL_COMPLETE: All PRD items passed"
  - Output: <complete/>'

run_with_agent() {
    local agent=$1
    local iteration=$2
    local result=""
    local exit_code=0

    case "$agent" in
        claude)
            # Use timeout to limit cost (no --max-turns flag exists, rely on prompt instructions)
            # --dangerously-skip-permissions allows autonomous operation without approval prompts
            result=$(timeout $TIMEOUT_SECONDS claude --print --dangerously-skip-permissions -p "$PROMPT" 2>&1) || exit_code=$?
            ;;
        codex)
            result=$(timeout $TIMEOUT_SECONDS codex --full-auto "$PROMPT" 2>&1) || exit_code=$?
            ;;
    esac

    # Check if we hit the timeout (exit code 124)
    if [ $exit_code -eq 124 ]; then
        result="$result
<timeout/>"
    fi

    echo "$result"
    return $exit_code
}

is_rate_limited() {
    local output="$1"
    if [[ "$output" == *"rate limit"* ]] || \
       [[ "$output" == *"Rate limit"* ]] || \
       [[ "$output" == *"429"* ]] || \
       [[ "$output" == *"too many requests"* ]] || \
       [[ "$output" == *"quota exceeded"* ]] || \
       [[ "$output" == *"out of extra usage"* ]] || \
       [[ "$output" == *"You're out of"* ]]; then
        return 0
    fi
    return 1
}

is_timeout() {
    local output="$1"
    if [[ "$output" == *"<timeout/>"* ]]; then
        return 0
    fi
    return 1
}

is_stuck() {
    local output="$1"
    if [[ "$output" == *"<stuck>"* ]]; then
        return 0
    fi
    return 1
}

is_done() {
    local output="$1"
    if [[ "$output" == *"<done>"* ]]; then
        return 0
    fi
    return 1
}

get_available_agent() {
    local now=$(date +%s)

    for agent in "${AGENTS[@]}"; do
        if ! command -v "$agent" &> /dev/null; then
            continue
        fi

        local limited_until="${RATE_LIMITED_UNTIL[$agent]:-0}"
        if [ "$now" -lt "$limited_until" ]; then
            local remaining=$(( (limited_until - now) / 60 ))
            echo "  $agent: rate limited for ~${remaining}m" >&2
            continue
        fi

        echo "$agent"
        return 0
    done

    return 1
}

mark_rate_limited() {
    local agent=$1
    local now=$(date +%s)
    RATE_LIMITED_UNTIL[$agent]=$((now + 18000))
    echo "Marked $agent as rate limited for 5 hours"
}

get_current_task() {
    # Get the first failing task's description
    jq -r '[.[] | select(.passes == false)][0] | "\(.category): \(.description)"' prd.json
}

fail_run() {
    local reason=$1
    echo ""
    echo "=== RUN FAILED ==="
    echo "$reason"
    echo ""
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] RUN_FAILED: $reason" >> progress.txt
    echo "Human intervention required. Check progress.txt for details." >> progress.txt
    echo ""
    echo "Branch: $BRANCH_NAME"
    echo "Progress log: progress.txt"
    exit 1
}

while [ $ITERATION -lt $MAX_ITERATIONS ]; do
    ITERATION=$((ITERATION + 1))
    echo "=== Iteration $ITERATION/$MAX_ITERATIONS ==="

    if [ ! -f prd.json ]; then
        fail_run "prd.json not found"
    fi

    # Check if all items pass
    if [ "$(jq '[.[] | .passes] | all' prd.json)" = "true" ]; then
        echo ""
        echo "=== ALL PRD ITEMS COMPLETE ==="
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] SUCCESS: All PRD items passed" >> progress.txt
        echo "Completed at: $(date)" >> progress.txt
        echo ""
        echo "Branch: $BRANCH_NAME"
        echo "Ready for PR"
        exit 0
    fi

    REMAINING=$(jq '[.[] | select(.passes == false)] | length' prd.json)
    CURRENT_TASK=$(get_current_task)

    echo "Remaining items: $REMAINING"
    echo "Current task: $CURRENT_TASK"
    echo ""

    # Get available agent
    AGENT=$(get_available_agent)
    if [ -z "$AGENT" ]; then
        fail_run "All agents rate limited"
    fi

    echo "Using agent: $AGENT"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ITERATION $ITERATION: Starting with $AGENT" >> progress.txt

    set +e
    RESULT=$(run_with_agent "$AGENT" "$ITERATION")
    EXIT_CODE=$?
    set -e

    # Check for rate limiting - try fallback agent once
    if is_rate_limited "$RESULT"; then
        echo "Rate limited by $AGENT, trying fallback..."
        mark_rate_limited "$AGENT"
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] RATE_LIMITED: $AGENT" >> progress.txt

        AGENT=$(get_available_agent)
        if [ -z "$AGENT" ]; then
            fail_run "All agents rate limited"
        fi

        echo "Switching to: $AGENT"
        set +e
        RESULT=$(run_with_agent "$AGENT" "$ITERATION")
        EXIT_CODE=$?
        set -e

        if is_rate_limited "$RESULT"; then
            mark_rate_limited "$AGENT"
            fail_run "All agents rate limited"
        fi
    fi

    echo "$RESULT"

    # Handle outcomes - fail immediately on any problem
    if is_timeout "$RESULT"; then
        fail_run "Task timed out after ${TIMEOUT_SECONDS}s: $CURRENT_TASK"
    elif is_stuck "$RESULT"; then
        fail_run "Task stuck: $CURRENT_TASK"
    elif is_done "$RESULT"; then
        echo ""
        echo "Task completed successfully!"
    elif [[ "$RESULT" == *"<complete/>"* ]]; then
        echo ""
        echo "=== ALL PRD ITEMS COMPLETE ==="
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] SUCCESS: All PRD items passed" >> progress.txt
        echo "Completed at: $(date)" >> progress.txt
        echo ""
        echo "Branch: $BRANCH_NAME"
        echo "Ready for PR"
        exit 0
    fi

    sleep 2
done

fail_run "Max iterations ($MAX_ITERATIONS) reached without completing all tasks"
