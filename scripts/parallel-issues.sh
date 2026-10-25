#!/usr/bin/env bash
# Work on several GitHub issues at once, each in its own git worktree with its
# own Claude Code session in a new Terminal window.
#
#   scripts/parallel-issues.sh 3 4 11 13     start sessions for these issues
#   scripts/parallel-issues.sh --force 5     start even if dependencies are open
#   scripts/parallel-issues.sh --list        show active issue worktrees
#   scripts/parallel-issues.sh --cleanup 4   remove worktree + branch for #4
#
# Requires: git, gh (logged in), npm, claude, macOS Terminal.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
PARENT_DIR="$(dirname "$REPO_ROOT")"
PROJECT="$(basename "$REPO_ROOT")"

worktree_dir() { echo "$PARENT_DIR/${PROJECT}-issue-$1"; }

slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40 | sed -E 's/-+$//'
}

# Prints the open issue numbers listed under "## Depends on" in issue $1.
open_dependencies() {
  local deps dep state
  deps="$(gh issue view "$1" --json body --jq .body \
    | awk '/^## Depends on/{f=1;next} /^## /{f=0} f' \
    | grep -oE '#[0-9]+' | tr -d '#' || true)"
  for dep in $deps; do
    state="$(gh issue view "$dep" --json state --jq .state)"
    [[ "$state" == "OPEN" ]] && echo "$dep"
  done
  return 0
}

write_prompt() {
  local issue="$1" title="$2" branch="$3" file="$4"
  cat >"$file" <<EOF
Implement GitHub issue #$issue: "$title".

1. Read the issue with \`gh issue view $issue\` and read the relevant PRD for context (PRD.md, docs/PRD-family-and-neighbour-homes.md).
2. You are in a dedicated git worktree on branch \`$branch\`, based on the latest main.
   Other Claude sessions are working on other issues in parallel, so:
   - keep changes inside the module folder(s) this issue owns, plus their tests;
   - keep edits to shared files (src/main.ts, package.json, README.md) minimal.
3. Follow the existing code style. Add headless Vitest tests for gameplay rules.
4. Run \`npm test\`, \`npm run typecheck\` and \`npm run build\`; fix any failures.
5. Commit, push the branch, and open a PR with \`gh pr create\` whose body
   starts with "Closes #$issue" and ticks off the issue's acceptance criteria.
6. Finish by summarising what you did and anything left for a human to check.
EOF
}

open_terminal() {
  local dir="$1" name="$2" prompt_file="$3"
  local cmd="cd '$dir' && claude -n '$name' \"\$(cat '$prompt_file')\""
  osascript - "$cmd" <<'APPLESCRIPT' >/dev/null
on run argv
  tell application "Terminal"
    activate
    do script (item 1 of argv)
  end tell
end run
APPLESCRIPT
}

start_issue() {
  local issue="$1" force="$2"
  local info title state branch dir prompt_file blockers

  info="$(gh issue view "$issue" --json title,state --jq '[.state, .title] | @tsv')"
  state="${info%%$'\t'*}"
  title="${info#*$'\t'}"

  if [[ "$state" != "OPEN" ]]; then
    echo "⏭  #$issue is $state — skipping."
    return
  fi

  blockers="$(open_dependencies "$issue" | tr '\n' ' ')"
  if [[ -n "$blockers" && "$force" != "1" ]]; then
    echo "⛔ #$issue depends on open issue(s): ${blockers}— skipping (use --force to override)."
    return
  fi

  branch="issue-$issue-$(slugify "$title")"
  dir="$(worktree_dir "$issue")"

  if [[ -d "$dir" ]]; then
    echo "↺  #$issue worktree already exists at $dir — reusing it."
  else
    echo "🌱 #$issue → $dir ($branch)"
    if git show-ref --verify --quiet "refs/heads/$branch"; then
      git worktree add "$dir" "$branch" >/dev/null
    else
      git worktree add "$dir" -b "$branch" origin/main >/dev/null
    fi
    if [[ -f "$dir/package-lock.json" ]]; then
      (cd "$dir" && npm ci --silent --no-audit --no-fund)
    fi
  fi

  # Keep the prompt inside the worktree's git dir so it can never be committed.
  prompt_file="$(cd "$dir" && git rev-parse --absolute-git-dir)/claude-issue-prompt.md"
  write_prompt "$issue" "$title" "$branch" "$prompt_file"
  open_terminal "$dir" "issue-$issue" "$prompt_file"
  echo "🚀 #$issue Claude session opened."
}

cleanup_issue() {
  local issue="$1" dir branch
  dir="$(worktree_dir "$issue")"
  if [[ ! -d "$dir" ]]; then
    echo "No worktree for #$issue at $dir"
    return
  fi
  branch="$(git -C "$dir" branch --show-current)"
  git worktree remove "$dir"
  echo "🧹 Removed $dir"
  if git branch -d "$branch" >/dev/null 2>&1; then
    echo "   Deleted merged branch $branch"
  else
    echo "   Kept branch $branch (not merged locally; delete with: git branch -D $branch)"
  fi
}

main() {
  local force=0 mode=start
  local issues=()
  for arg in "$@"; do
    case "$arg" in
      --force) force=1 ;;
      --cleanup) mode=cleanup ;;
      --list) mode=list ;;
      -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
      *[!0-9]*|'') echo "Unknown argument: $arg" >&2; exit 1 ;;
      *) issues+=("$arg") ;;
    esac
  done

  cd "$REPO_ROOT"

  if [[ "$mode" == list ]]; then
    git worktree list | grep -- "-issue-" || echo "No issue worktrees."
    return
  fi

  if [[ ${#issues[@]} -eq 0 ]]; then
    echo "Usage: $0 [--force] <issue>... | --cleanup <issue>... | --list" >&2
    exit 1
  fi

  if [[ "$mode" == cleanup ]]; then
    git fetch origin --prune --quiet
    for issue in "${issues[@]}"; do cleanup_issue "$issue"; done
    git worktree prune
    return
  fi

  git fetch origin --quiet
  for issue in "${issues[@]}"; do start_issue "$issue" "$force"; done
}

main "$@"
