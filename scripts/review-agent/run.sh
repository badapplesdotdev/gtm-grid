#!/usr/bin/env bash
# Run the Claude Code risk reviewer against a PR and emit a verdict JSON.
#
# Usage: scripts/review-agent/run.sh <pr-number>
# Writes the validated verdict to $VERDICT_OUT (default: ./verdict.json) and also
# echoes it to stdout. Exits non-zero if no valid verdict could be produced.
#
# The agent ONLY reads (diff + repo context) and writes the verdict file — it does
# NOT merge or review. The caller (the workflow) enforces policy and performs the
# mutation. This script is always run from the trusted base checkout, never from
# PR-authored code.
set -euo pipefail

PR="${1:?usage: run.sh <pr-number>}"

# Self-hosted macOS runners (launchd) start with a minimal PATH; make sure the
# Homebrew tools and the user-local claude binary are reachable.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"

MODEL="${REVIEW_MODEL:-claude-opus-4-8}"
VERDICT_OUT="${VERDICT_OUT:-$PWD/verdict.json}"
AGENT_LOG="${AGENT_LOG:-$PWD/agent.log}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

rm -f "$VERDICT_OUT"

command -v claude >/dev/null 2>&1 || { echo "::error::claude CLI not found on runner PATH"; exit 127; }
command -v gh >/dev/null 2>&1 || { echo "::error::gh CLI not found on runner PATH"; exit 127; }

# Auth: on our self-hosted Mac the launchd runner uses the machine's local Claude
# Max login (same pattern as trigify-app's self-hosted jobs — no API key/gateway).
# A CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY env (from a repo secret) overrides
# it if set, for portability to cloud runners.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "auth: using CLAUDE_CODE_OAUTH_TOKEN from env"
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "auth: using ANTHROPIC_API_KEY from env"
else
  echo "auth: no token in env — using the runner's local Claude login"
fi

echo "Reviewing PR #$PR with model $MODEL"

META="$(gh pr view "$PR" --json number,title,author,baseRefName,headRefName,additions,deletions,changedFiles,files,body,isDraft,labels)"
DIFF="$(gh pr diff "$PR")"

# Cap the diff we inline so a huge PR can't blow the prompt. The agent can still
# pull more via `gh` if it needs to; an oversized diff is itself a risk signal.
MAX_DIFF_BYTES="${MAX_DIFF_BYTES:-400000}"
DIFF_BYTES="${#DIFF}"
DIFF_NOTE=""
if [ "$DIFF_BYTES" -gt "$MAX_DIFF_BYTES" ]; then
  DIFF="$(printf '%s' "$DIFF" | head -c "$MAX_DIFF_BYTES")"
  DIFF_NOTE=$'\n\n> NOTE: diff truncated to '"$MAX_DIFF_BYTES"$' bytes (original '"$DIFF_BYTES"$'). A very large diff is itself a risk signal — lean toward human_review.'
fi

PROMPT="$(cat "$HERE/prompt.md")"

INPUT="$PROMPT

## PR METADATA (JSON)
$META

## FULL DIFF
\`\`\`diff
$DIFF
\`\`\`$DIFF_NOTE

When finished, use the Write tool to write your verdict JSON to this exact path:
$VERDICT_OUT"

# Read-only tool surface + Write for the verdict. The diff is already inline, so
# the agent can produce a verdict even if a tool is unavailable.
ALLOWED="Read,Grep,Glob,Write,Bash(gh pr view:*),Bash(gh pr diff:*),Bash(gh api:*),Bash(git log:*),Bash(git diff:*),Bash(git show:*)"

set +e
printf '%s' "$INPUT" | claude -p \
  --model "$MODEL" \
  --allowedTools "$ALLOWED" \
  --permission-mode acceptEdits \
  --output-format json \
  > "$AGENT_LOG" 2>&1
CLAUDE_RC=$?
set -e

# Primary: the verdict file the agent was told to write.
# Fallback: extract the final assistant message from --output-format json and pull
# the first JSON object out of it.
if [ ! -s "$VERDICT_OUT" ]; then
  echo "verdict file not written (claude rc=$CLAUDE_RC); attempting to recover from agent output" >&2
  RESULT="$(jq -r '.result // empty' "$AGENT_LOG" 2>/dev/null || true)"
  if [ -n "$RESULT" ]; then
    printf '%s' "$RESULT" | sed -n '/{/,/}/p' | jq -c . > "$VERDICT_OUT" 2>/dev/null || true
  fi
fi

if ! jq -e 'has("recommendation") and has("risk") and has("is_new_feature")' "$VERDICT_OUT" >/dev/null 2>&1; then
  echo "::error::review agent did not produce a valid verdict.json"
  echo "----- agent.log (tail) -----" >&2
  tail -n 40 "$AGENT_LOG" >&2 || true
  exit 3
fi

echo "----- verdict -----"
jq . "$VERDICT_OUT"
