#!/usr/bin/env bash
# Fails when a pull request title is not `type(scope): subject`.
# CI runs it on every pull request (.github/workflows/pr-title.yml). Run it yourself with:
#   ./scripts/check-pr-title.sh "fix(gateway): hold webhooks of a pending WABA"
set -euo pipefail

title="${1:-}"
pattern='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)\([a-z0-9][a-z0-9-]*\)!?: [^[:space:]].*$'
revert='^Revert ".+"$'

if [[ "$title" =~ $pattern || "$title" =~ $revert ]]; then
  exit 0
fi

cat >&2 <<EOF
PR title is not in the form type(scope): subject

  got:      $title
  expected: type(scope): subject
  types:    feat fix docs style refactor perf test build ci chore revert
  breaking: add ! before the colon, as in feat(core)!: drop a field
  reverts:  GitHub's Revert button title, Revert "<original title>", also passes
  scope:    the area the change lands in, lowercase: gateway, console, site, docs, core, repo, ...
  example:  fix(gateway): hold webhooks of a pending WABA instead of dropping them

Rename the pull request. CI reruns on the edit.
EOF
exit 1
