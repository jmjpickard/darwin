#!/bin/bash
# ralph.sh - The Ralph Wiggum Method
# "I'm helping!" - Ralph Wiggum
#
# A simple loop that runs Claude Code iterations until all PRD items pass.
# Each iteration picks one failing item, implements it, tests it, and commits.
# Falls back to Codex if rate limited.

set -e

MAX_ITERATIONS=${1:-10}
ITERATION=0

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
echo ""

# Track which agents are rate limited (with timestamp for 5hr window)
declare -A RATE_LIMITED_UNTIL

PROMPT="@prd.json @progress.txt
Pick ONE item with passes:false. Implement it. Run tests/typecheck.
If passes, update prd.json to set passes:true. Commit with a clear message.
If ALL items pass, output: <promise>COMPLETE</promise>
Log progress to progress.txt with iteration number and what you did."

run_with_agent() {
    local agent=$1
    local result=""
    local exit_code=0
    
    case "$agent" in
        claude)
            result=$(claude --print --permission-mode acceptEdits -p "$PROMPT" 2>&1) || exit_code=$?
            ;;
        codex)
            result=$(codex --full-auto "$PROMPT" 2>&1) || exit_code=$?
            ;;
    esac
    
    echo "$result"
    return $exit_code
}

is_rate_limited() {
    local output="$1"
    if [[ "$output" == *"rate limit"* ]] || \
       [[ "$output" == *"Rate limit"* ]] || \
       [[ "$output" == *"429"* ]] || \
       [[ "$output" == *"too many requests"* ]] || \
       [[ "$output" == *"quota exceeded"* ]]; then
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
    echo "Remaining items: $REMAINING"
    echo ""

    AGENT=$(get_available_agent)
    if [ -z "$AGENT" ]; then
        echo "All agents rate limited. Waiting 30 minutes..."
        sleep 1800
        continue
    fi
    
    echo "Using agent: $AGENT"
    
    set +e
    RESULT=$(run_with_agent "$AGENT")
    EXIT_CODE=$?
    set -e

    if is_rate_limited "$RESULT"; then
        echo "Rate limited by $AGENT, trying next agent..."
        mark_rate_limited "$AGENT"
        
        AGENT=$(get_available_agent)
        if [ -n "$AGENT" ]; then
            echo "Switching to: $AGENT"
            set +e
            RESULT=$(run_with_agent "$AGENT")
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

    if [[ "$RESULT" == *"<promise>COMPLETE</promise>"* ]]; then
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
