#!/bin/bash
# ralph.sh - The Ralph Wiggum Method
# "I'm helping!" - Ralph Wiggum
#
# A simple loop that runs Claude Code iterations until all PRD items pass.
# Each iteration picks one failing item, implements it, tests it, and commits.
#
# Usage:
#   ./ralph.sh [max_iterations]
#   ./ralph.sh 20         # Run up to 20 iterations
#   ./ralph.sh            # Default: 10 iterations
#
# Prerequisites:
#   - prd.json in current directory with PRD items
#   - jq installed for JSON parsing
#   - claude CLI installed and authenticated

set -e

MAX_ITERATIONS=${1:-10}
ITERATION=0

# Initialize progress.txt if it doesn't exist
if [ ! -f progress.txt ]; then
    echo "# Progress Log" > progress.txt
    echo "Started: $(date)" >> progress.txt
    echo "" >> progress.txt
fi

echo "=== Ralph Wiggum Method ==="
echo "Max iterations: $MAX_ITERATIONS"
echo ""

while [ $ITERATION -lt $MAX_ITERATIONS ]; do
    ITERATION=$((ITERATION + 1))
    echo "=== Iteration $ITERATION/$MAX_ITERATIONS ==="

    # Check if prd.json exists
    if [ ! -f prd.json ]; then
        echo "Error: prd.json not found"
        exit 1
    fi

    # Check if all items pass
    if [ "$(jq '[.[] | .passes] | all' prd.json)" = "true" ]; then
        echo ""
        echo "All PRD items pass!"
        echo "Completed at: $(date)" >> progress.txt
        exit 0
    fi

    # Count remaining items
    REMAINING=$(jq '[.[] | select(.passes == false)] | length' prd.json)
    echo "Remaining items: $REMAINING"
    echo ""

    # Run Claude Code
    # --allowedTools pre-approves tools for headless operation (no prompts)
    RESULT=$(claude --print --allowedTools "Bash,Read,Edit,Write,Glob,Grep,WebFetch" -p "@prd.json @progress.txt
Pick ONE item with passes:false. Implement it. Run tests/typecheck.
If passes, update prd.json to set passes:true. Commit with a clear message.
If ALL items pass, output: <promise>COMPLETE</promise>
Log progress to progress.txt with iteration number and what you did.")

    echo "$RESULT"

    # Check for completion signal
    if [[ "$RESULT" == *"<promise>COMPLETE</promise>"* ]]; then
        echo ""
        echo "PRD complete signal received!"
        echo "Completed at: $(date)" >> progress.txt
        exit 0
    fi

    # Brief pause between iterations
    sleep 2
done

echo ""
echo "Max iterations ($MAX_ITERATIONS) reached"
echo "Max iterations reached at: $(date)" >> progress.txt
exit 1
