#!/usr/bin/env bash
# Query the Omnisearch plugin in a running Obsidian vault.
# Obsidian must be running with the Omnisearch plugin enabled.
#
# Usage:
#   omnisearch.sh <query> [--vault <name>] [--limit <n>] [--format excerpts|paths|json]
#
# Formats:
#   excerpts  (default) path, score, and surrounding text for each result
#   paths     one file path per line — easy to pipe into other commands
#   json      pretty-printed full JSON array

set -euo pipefail

QUERY=""
VAULT=""
LIMIT="50"
FORMAT="excerpts"

usage() {
    echo "Usage: omnisearch.sh <query> [--vault <name>] [--limit <n>] [--format excerpts|paths|json]" >&2
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --vault|-v)  VAULT="$2";  shift 2 ;;
        --limit|-l)  LIMIT="$2";  shift 2 ;;
        --format|-f) FORMAT="$2"; shift 2 ;;
        --help|-h)   usage ;;
        -*)          echo "Unknown option: $1" >&2; usage ;;
        *)           QUERY="$1"; shift ;;
    esac
done

[[ -z "$QUERY" ]] && usage

# JSON-encode the query so quotes and special chars are safe in the JS string.
ESCAPED=$(printf '%s' "$QUERY" | python3 -c 'import json,sys; sys.stdout.write(json.dumps(sys.stdin.read()))')
JS="const r=await omnisearch.search($ESCAPED); JSON.stringify(r.slice(0,$LIMIT))"

if [[ -n "$VAULT" ]]; then
    RAW=$(obsidian vault="$VAULT" eval code="$JS")
else
    RAW=$(obsidian eval code="$JS")
fi

case "$FORMAT" in
    json)
        echo "$RAW" | python3 -m json.tool
        ;;
    paths)
        echo "$RAW" | python3 -c '
import json, sys
for r in json.load(sys.stdin):
    print(r["path"])
'
        ;;
    excerpts|*)
        echo "$RAW" | python3 -c '
import json, sys
results = json.load(sys.stdin)
if not results:
    print("No results.")
    sys.exit(0)
for r in results:
    score = r.get("score", 0)
    print(f"{r[\"path\"]}  (score: {score:.1f})")
    excerpt = r.get("excerpt", "").strip()
    if excerpt:
        print(f"  {excerpt}")
    print()
'
        ;;
esac
