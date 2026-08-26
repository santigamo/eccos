#!/usr/bin/env bash
# Eccos site link checker — verify every internal href/src/anchor in the generated
# pages under apps/site/dist resolves, and that no page links a route that does
# not exist. Run from the repo root after building the site:
#
#   ./scripts/check-site-links.sh
#
# Pure shell + rg + python3; no dependencies. Exits non-zero on the first
# problem found (safe to gate a deploy on its exit code).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SITE_ROOT="${SITE_ROOT:-$ROOT/apps/site/dist}"
if [[ ! -d "$SITE_ROOT" ]]; then
  echo "site output directory not found: $SITE_ROOT (run bun run check:site first)" >&2
  exit 1
fi
cd "$SITE_ROOT"

fail=0

# Every generated HTML file in dist/ (index, subdirectories, and 404.html).
PAGES=$(rg --files -g '*.html' | sort)
if [[ -z "$PAGES" ]]; then
  echo "no pages found under $SITE_ROOT" >&2
  exit 1
fi

echo "==> checking pages in $SITE_ROOT"
echo "$PAGES"

for page in $PAGES; do
  file="${page#./}"

  # Internal hrefs/srcs that point at the site itself (/, /privacy, assets…).
  # Skip: external http(s), mailto, fragment-only, and query-only hrefs.
  refs="$(
    rg -o '(href|src)="[^"]+"' "$file" \
      | sed -E 's/^(href|src)="//; s/"$//' \
      | rg '^/' || true
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
  if ! python3 - "$file" <<'PY'
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
ids = set(re.findall(r'id="([^"]+)"', src))
anchors = [a for a in re.findall(r'href="#([^"]*)"', src) if a]
missing = [a for a in anchors if a not in ids]
if missing:
    print(f"  MISSING ANCHOR: {sys.argv[1]} -> {missing}", file=sys.stderr)
    sys.exit(1)
PY
  then
    fail=1
  fi
done

if [[ $fail -ne 0 ]]; then
  echo "" >&2
  echo "Site link check FAILED" >&2
  exit 1
fi

echo "All internal links and anchors resolve."
