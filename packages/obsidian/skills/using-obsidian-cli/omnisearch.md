# Omnisearch

Omnisearch is a full-text search plugin that scores results by relevance, returns excerpts with match context, and is significantly more powerful than the built-in `obsidian search` for finding notes by content.

## Quick start

```shell
bash scripts/omnisearch.sh "your query"
bash scripts/omnisearch.sh "your query" --vault wiki
bash scripts/omnisearch.sh "your query" --limit 10 --format paths
```

## Script reference

```
omnisearch.sh <query> [--vault <name>] [--limit <n>] [--format excerpts|paths|json]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--vault <name>` | active vault | Target a specific vault by name |
| `--limit <n>` | 50 | Maximum number of results |
| `--format excerpts` | ✓ default | Path, score, and surrounding text |
| `--format paths` | | One file path per line — easy to pipe |
| `--format json` | | Full pretty-printed JSON array |

## Output formats

### excerpts (default)
```
Projects/project-phoenix.md  (score: 84.2)
  ...the Project Phoenix kickoff meeting confirmed the new timeline...

Journal/2026-04-10.md  (score: 61.0)
  ...discussed Project Phoenix blockers with the team...
```

### paths
```
Projects/project-phoenix.md
Journal/2026-04-10.md
Notes/Q2 Planning.md
```

### json
```json
[
  {
    "score": 84.2,
    "vault": "wiki",
    "path": "Projects/project-phoenix.md",
    "basename": "project-phoenix",
    "foundWords": ["project", "phoenix"],
    "matches": [{ "match": "Project Phoenix", "offset": 142 }],
    "excerpt": "...the Project Phoenix kickoff meeting confirmed..."
  }
]
```

## Result fields

| Field | Description |
|-------|-------------|
| `score` | Relevance score — higher is better |
| `vault` | Vault name the result belongs to |
| `path` | Path relative to vault root |
| `basename` | Filename without extension |
| `foundWords` | Query words matched in this note |
| `matches` | Each match with its character offset |
| `excerpt` | Surrounding text snippet for the first match |

## Examples

```shell
# Find notes about a topic
bash scripts/omnisearch.sh "Q2 planning retro"

# Targeted search in a specific vault
bash scripts/omnisearch.sh "deployment checklist" --vault wiki

# Get just paths to pipe into other commands
bash scripts/omnisearch.sh "TODO" --format paths | xargs -I{} obsidian open path={}

# Narrow to top results
bash scripts/omnisearch.sh "meeting notes" --limit 5

# Get full JSON for downstream processing
bash scripts/omnisearch.sh "API design" --format json | python3 -c '
import json, sys
results = json.load(sys.stdin)
for r in results:
    print(r["path"], "->", r["foundWords"])
'
```

## Direct invocation (without the script)

If you need to call Omnisearch without the script, use `obsidian eval`:

```shell
obsidian eval code="JSON.stringify(await omnisearch.search('your query'))"
obsidian vault=wiki eval code="JSON.stringify(await omnisearch.search('your query'))"
```

Or access through the plugin registry:

```shell
obsidian eval code="JSON.stringify(await app.plugins.plugins.omnisearch.api.search('your query'))"
```

## HTTP API (disabled by default)

Omnisearch has a built-in HTTP server that allows querying without the `obsidian` CLI tool at all. To enable it: **Settings → Omnisearch → HTTP API** (default port: `51361`).

```shell
curl "http://localhost:51361/search?q=your+query"
```

The response is the same JSON array as the `eval`-based approach. Useful for non-interactive scripts or external tooling that shouldn't depend on the CLI.

## Notes

- Obsidian must be running with Omnisearch enabled for any of these approaches to work.
- The `omnisearch.search()` API is async — the script handles this via `obsidian eval`'s `await` support.
- Scores are not normalized; compare results within a single query, not across queries.
