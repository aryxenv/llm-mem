# llm-mem

`llm-mem` is a local-first **Context Compiler** for token-efficient coding agents. It does not replace tools like Copilot CLI, Claude Code, Codex, or OpenCode. Instead, it gives them compact, source-grounded context packs so they can reason with less repeated context and fewer wasted tokens.

The thesis: token waste is usually caused by repeated discovery, stale summaries, duplicated agent work, and unproven context sufficiency. `llm-mem` attacks those causes with structural indexing, proof-carrying context packs, semantic patch memory, worktree orchestration, and evaluation-driven optimization.

## Initial surfaces

- CLI for local workflows.
- Local daemon for shared memory and indexing.
- MCP-compatible JSON-RPC server for coding tools.
- SQLite-backed memory and retrieval.
- Git worktree leases for safe parallel agent work.

## How this helps in practice

Most coding-agent token waste comes from rediscovering project structure: reading the same files, re-learning conventions, restating prior decisions, and dumping broad context because the agent cannot prove which small slice is enough. `llm-mem` reduces that waste by indexing the repo once and compiling a task-specific, source-grounded context pack before the coding agent starts.

The practical flow is:

1. Index the repo.
2. Ask `llm-mem` for a context pack for the task.
3. Give that pack to Copilot CLI, Claude Code, Codex, OpenCode, or another coding tool.
4. Compare quality and token/cost telemetry against a baseline run without `llm-mem`.

Manual Copilot CLI workflow:

```powershell
npm install
npm run build

node apps\cli\dist\index.js init
node apps\cli\dist\index.js index
node apps\cli\dist\index.js context "Fix the cache invalidation bug" --budget 8000 > .llm-mem\context-pack.json

copilot --model gpt-5.5 --allow-all-tools --no-ask-user -p "Use .llm-mem/context-pack.json as source-grounded context, then fix the task."
```

Convenience workflow:

```powershell
node apps\cli\dist\index.js copilot run "Fix the cache invalidation bug" --budget 8000 --model gpt-5.5
```

Use `--dry-run` to inspect the generated prompt and artifacts without invoking Copilot:

```powershell
node apps\cli\dist\index.js copilot run "Explain the ContextCompiler" --dry-run
```

Artifacts are written under `.llm-mem/runs/`.

## Benchmarking the value

Unit tests only prove the implementation works. They do not prove the token-efficiency thesis. For that, use A/B benchmark runs:

- `baseline-copilot`: Copilot CLI receives only the task prompt.
- `llm-mem-context`: Copilot CLI receives the task prompt plus a generated context pack.

Run a deterministic dry benchmark:

```powershell
node apps\cli\dist\index.js benchmark list
node apps\cli\dist\index.js benchmark run evals\benchmarks\smoke.json --dry-run
```

Run live Copilot CLI after reviewing the suite:

```powershell
node apps\cli\dist\index.js benchmark run evals\benchmarks\smoke.json --model gpt-5.5
```

Live benchmark runs create isolated git worktrees by default so Copilot does not mutate your main working tree. Use `--no-worktree` only when you intentionally want to run in the current worktree.

Reports are written under `.llm-mem/benchmarks/<run-id>/` and include prompt-token estimates, context-token estimates, context recall, test results, resolved status, and per-variant aggregates.

For credible external benchmarking, use pinned open-source fixtures first, then SWE-bench Lite or SWE-bench Verified subset manifests. SWE-bench reports `% Resolved`, so `llm-mem` benchmark reports should always show quality metrics next to token/cost metrics. Token savings without equal-or-better quality should not count as success.

## Development

```powershell
npm install
npm run build
npm test
```

Optional live Copilot smoke tests are gated and never run by default:

```powershell
$env:LLM_MEM_LIVE_COPILOT=1
npm run test:live
```

## Status

This repository is in early implementation. The first milestone is a working local MVP that can index a repo, store source-grounded memory, produce context packs, expose CLI/MCP surfaces, manage safe worktree leases, and measure token savings against quality. The next focus is credible live benchmarking against Copilot CLI and SWE-bench-style task suites.
