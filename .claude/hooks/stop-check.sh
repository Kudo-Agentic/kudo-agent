#!/usr/bin/env bash
# Stop hook: Claude cannot end a turn while an agent JSON fails to parse (an
# identity.json raw URL can be an on-chain tokenURI), the workspace (the public
# packages and the agents) fails to typecheck, the packages' unit tests
# fail, or a skill names a wrong or legacy contract address. Exit 2 sends the errors back to Claude.

CODE_PATTERN='(\.json|\.ts|\.mjs|\.md|\.txt|\.sh)$'

check() {
  for f in *.json agents/*/identity.json agents/*/agent-card.json; do
    [ -f "$f" ] || continue
    node -e "JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\"))" "$f" \
      || { echo "invalid JSON: $f"; return 1; }
  done
  node scripts/check-skill-addresses.mjs || return 1
  # The npm workspace: packages/sdk (with startAgent), packages/tools, packages/mcp,
  # packages/plugin-kudo and the two agents. Typecheck always (the agents have
  # no tests); run the unit tests when packages/ changed.
  { [ -d node_modules ] || npm ci --no-audit --no-fund >/dev/null; } \
    && npm run --silent typecheck || return 1
  if git diff --name-only "$base" 2>/dev/null | grep -q '^packages/' \
     || git ls-files --others --exclude-standard packages | grep -q .; then
    npm test --silent
  fi
}

# ---- shared below this line: keep in step across the Kudo repos ----

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 0

input=$(cat)
session=$(printf '%s' "$input" | node -e '
  let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => {
    try { console.log(JSON.parse(s).session_id || "none") } catch { console.log("none") }
  })' 2>/dev/null || echo none)
strikes="${TMPDIR:-/tmp}/claude-stop-check-$(basename "$PWD")-$session"

# Only check when this branch touches code: a question-only turn ends at once.
base=$(git merge-base HEAD origin/main 2>/dev/null || git rev-parse HEAD)
changed=$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } 2>/dev/null \
  | grep -E "$CODE_PATTERN" | head -1)
[ -z "$changed" ] && exit 0

if out=$(check 2>&1); then
  rm -f "$strikes"
  exit 0
fi

n=$(( $(cat "$strikes" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$strikes"
if [ "$n" -gt 3 ]; then
  # Don't loop forever: let the turn end, but make the failure visible.
  rm -f "$strikes"
  printf '{"systemMessage":"Stop check still failing after 3 attempts - the code is broken, do not merge."}\n'
  exit 0
fi

{
  echo "Stop check failed (attempt $n/3): fix this before ending the turn."
  echo "Never skip, weaken or delete a check to get green."
  echo
  printf '%s\n' "$out" | tail -60
} >&2
exit 2
