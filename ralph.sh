#!/bin/bash
# ralph.sh - The Ralph Wiggum Method
# "I'm helping!" - Ralph Wiggum
#
# A simple loop that runs Claude Code iterations until all PRD items pass.
# Each iteration picks one failing item, implements it, tests it, and commits.
# Falls back to Codex if rate limited.
#
# Cost controls:
# - 5 minute timeout per iteration
# - Prompt instructs Claude to stop after ~20 tool calls
# - Atomic single-action tasks in prd.json

set -e

MAX_ITERATIONS=${1:-10}
ITERATION=0
TIMEOUT_SECONDS=300  # 5 minutes
LIVE_PROGRESS_FILE="progress-live.txt"

# Agent preference order
AGENTS=("claude" "codex")

# Initialize progress.txt if it doesn't exist
if [ ! -f progress.txt ]; then
    echo "# Progress Log" > progress.txt
    echo "Started: $(date)" >> progress.txt
    echo "" >> progress.txt
fi

echo "=== Ralph Wiggum Method ==="
echo "Max iterations: $MAX_ITERATIONS"
echo "Timeout: ${TIMEOUT_SECONDS}s per iteration"
echo ""

# Track which agents are rate limited (with timestamp for 5hr window)
declare -A RATE_LIMITED_UNTIL

# Track failures per task (by index)
declare -A TASK_FAILURES

PROMPT='@prd.json

CONSTRAINTS:
- You have MAX 20 tool calls. If you are approaching the limit, STOP immediately.
- DO NOT explore the codebase extensively. Only read files directly mentioned in the task.
- Try ONE approach. If it fails, STOP - do not try multiple alternatives.
- Be efficient. Delete files directly, do not read them first.

PROGRESS TRACKING:
After each significant action, append a timestamped line to progress-live.txt:
  [HH:MM:SS] ACTION: description
Examples:
  [10:30:15] READ: prd.json - found 5 remaining tasks
  [10:30:18] DELETE: src/core/terminal-controller.ts
  [10:30:22] BUILD: running npm run build
  [10:30:45] DONE: task completed successfully
  [10:31:02] STUCK: build failed - cannot find module X

TASK:
1. Find the FIRST item in prd.json with passes:false
2. Execute ONLY the action described in that item (the "action" field)
3. Run: npm run build
4. If build passes:
   - Update prd.json to set passes:true for this item
   - Commit with message: "ralph: [action description]"
   - Output: <done>action description</done>
5. If build fails:
   - Output: <stuck>brief error description</stuck>
   - DO NOT try to fix it, just stop

If ALL items in prd.json have passes:true, output: <complete/>'

run_with_agent() {
    local agent=$1
    local iteration=$2
    local result=""
    local exit_code=0

    # Clear live progress file at start of iteration
    echo "=== Iteration $iteration started at $(date) ===" > "$LIVE_PROGRESS_FILE"

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
        echo "[TIMEOUT] Iteration timed out after ${TIMEOUT_SECONDS}s" >> "$LIVE_PROGRESS_FILE"
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

get_current_task_index() {
    # Get the index of the first failing task
    jq -r 'to_entries | map(select(.value.passes == false)) | .[0].key // empty' prd.json
}

while [ $ITERATION -lt $MAX_ITERATIONS ]; do
    ITERATION=$((ITERATION + 1))
    echo "=== Iteration $ITERATION/$MAX_ITERATIONS ==="

    if [ ! -f prd.json ]; then
        echo "Error: prd.json not found"
        exit 1
    fi

    if [ "$(jq '[.[] | .passes] | all' prd.json)" = "true" ]; then
        echo ""
        echo "All PRD items pass!"
        echo "Completed at: $(date)" >> progress.txt
        exit 0
    fi

    REMAINING=$(jq '[.[] | select(.passes == false)] | length' prd.json)
    CURRENT_TASK_INDEX=$(get_current_task_index)
    CURRENT_TASK=$(jq -r ".[$CURRENT_TASK_INDEX].action // .[$CURRENT_TASK_INDEX].description" prd.json)
    TASK_FAILURE_COUNT=${TASK_FAILURES[$CURRENT_TASK_INDEX]:-0}

    echo "Remaining items: $REMAINING"
    echo "Current task [$CURRENT_TASK_INDEX]: $CURRENT_TASK"
    echo "Previous failures on this task: $TASK_FAILURE_COUNT"
    echo ""

    # Skip task if it has failed 3 times
    if [ "$TASK_FAILURE_COUNT" -ge 3 ]; then
        echo "Task has failed 3 times, marking as skipped..."
        # Mark as skipped by setting a skip flag (we'll handle this manually)
        jq ".[$CURRENT_TASK_INDEX].skipped = true" prd.json > prd.json.tmp && mv prd.json.tmp prd.json
        echo "Iteration $ITERATION: SKIPPED task after 3 failures: $CURRENT_TASK" >> progress.txt
        continue
    fi

    AGENT=$(get_available_agent)
    if [ -z "$AGENT" ]; then
        echo "All agents rate limited. Waiting 30 minutes..."
        sleep 1800
        continue
    fi

    echo "Using agent: $AGENT"

    set +e
    RESULT=$(run_with_agent "$AGENT" "$ITERATION")
    EXIT_CODE=$?
    set -e

    if is_rate_limited "$RESULT"; then
        echo "Rate limited by $AGENT, trying next agent..."
        mark_rate_limited "$AGENT"

        AGENT=$(get_available_agent)
        if [ -n "$AGENT" ]; then
            echo "Switching to: $AGENT"
            set +e
            RESULT=$(run_with_agent "$AGENT" "$ITERATION")
            EXIT_CODE=$?
            set -e

            if is_rate_limited "$RESULT"; then
                mark_rate_limited "$AGENT"
                echo "Also rate limited. Waiting 30 minutes..."
                sleep 1800
                continue
            fi
        else
            echo "No agents available. Waiting 30 minutes..."
            sleep 1800
            continue
        fi
    fi

    echo "$RESULT"

    # Handle different outcomes
    if is_timeout "$RESULT"; then
        echo ""
        echo "Iteration timed out!"
        TASK_FAILURES[$CURRENT_TASK_INDEX]=$((TASK_FAILURE_COUNT + 1))
        echo "Iteration $ITERATION: TIMEOUT on task: $CURRENT_TASK" >> progress.txt
    elif is_stuck "$RESULT"; then
        echo ""
        echo "Claude reported stuck!"
        TASK_FAILURES[$CURRENT_TASK_INDEX]=$((TASK_FAILURE_COUNT + 1))
        echo "Iteration $ITERATION: STUCK on task: $CURRENT_TASK" >> progress.txt
    elif is_done "$RESULT"; then
        echo ""
        echo "Task completed successfully!"
        echo "Iteration $ITERATION: DONE: $CURRENT_TASK" >> progress.txt
    elif [[ "$RESULT" == *"<complete/>"* ]]; then
        echo ""
        echo "PRD complete signal received!"
        echo "Completed at: $(date)" >> progress.txt
        exit 0
    fi

    sleep 2
done

echo ""
echo "Max iterations ($MAX_ITERATIONS) reached"
echo "Max iterations reached at: $(date)" >> progress.txt
exit 1
