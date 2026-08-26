#!/usr/bin/env bash
# Eccos site link checker — verify every internal href/src/anchor in the static
# pages under apps/site/public resolves, and that no page links a route that
# does not exist. Run from the repo root:
#
#   ./scripts/check-site-links.sh
#
# Pure shell + grep + python3; no dependencies. Exits non-zero on the first
# problem found (safe to gate a deploy on its exit code).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PUBLIC="$ROOT/apps/site/public"
cd "$PUBLIC"

fail=0

# Every HTML file in public/ (index + subdirectories like privacy/, migrate/).
PAGES=$(find . -name "index.html" -type f | sort)
if [[ -z "$PAGES" ]]; then
  echo "no pages found under $PUBLIC" >&2
  exit 1
fi

echo "==> checking pages in apps/site/public"
echo "$PAGES"

for page in $PAGES; do
  file="${page#./}"
  dir="$(dirname "$file")"

  # Internal hrefs/srcs that point at the site itself (/, /privacy, assets…).
  # Skip: external http(s), mailto, fragment-only, and query-only hrefs.
  refs="$(
    grep -oE '(href|src)="[^"]+"' "$file" \
      | sed -E 's/^(href|src)="//; s/"$//' \
      | grep -E '^/' || true
  )"

  for ref in $refs; do
    path="${ref%%#*}"
    path="${path%%\?*}"
    if [[ -z "$path" || "$path" == "/" ]]; then
      continue
    fi

    # /privacy and /privacy/ both resolve to privacy/index.html
    rel="${path#/}"
    rel="${rel%/}"
    if [[ -n "$rel" && ! -e "$rel/index.html" && ! -e "$rel" ]]; then
      echo "  MISSING: $file -> $ref (no $rel or $rel/index.html)" >&2
      fail=1
    fi
  done

  # Same-page anchors: every href="#x" must have a matching id in the page.
  python3 - "$file" <<'PY'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
ids = set(re.findall(r'id="([^"]+)"', src))
anchors = [a for a in re.findall(r'href="#([^"]*)"', src) if a]
missing = [a for a in anchors if a not in ids]
if missing:
    print(f"  MISSING ANCHOR: {sys.argv[1]} -> {missing}", file=sys.stderr)
    sys.exit(1)
PY
  if [[ $? -ne 0 ]]; then fail=1; fi
done

if [[ $fail -ne 0 ]]; then
  echo "" >&2
  echo "Site link check FAILED" >&2
  exit 1
fi

echo "All internal links and anchors resolve."
