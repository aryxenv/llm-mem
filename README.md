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

The intended user experience is install-and-forget: configure a repo once, then keep launching your normal coding tool. For Copilot CLI, that means you should still type:

```powershell
copilot
```

Project-local integration:

```powershell
npm install
npm run build

node apps\cli\dist\index.js integrate copilot install
copilot
```

The install command:

1. Initializes and indexes the repository.
2. Adds a project-local `.mcp.json` entry for the `llm-mem` MCP server.
3. Adds a marked block to `.github\copilot-instructions.md` telling Copilot to call `llm_mem.context_pack` before coding tasks.
4. Preserves the existing Copilot CLI flow; no PATH hijacking or replacement `copilot` binary is required.

Inspect or remove the integration:

```powershell
node apps\cli\dist\index.js integrate copilot status
node apps\cli\dist\index.js integrate copilot uninstall
```

Use `--dry-run` to preview file changes without writing, and `--skip-index` if you do not want install to index immediately.

Advanced/manual Copilot CLI workflow:

```powershell
node apps\cli\dist\index.js context "Fix the cache invalidation bug" --budget 8000 > .llm-mem\context-pack.json

copilot --model gpt-5.5 --allow-all-tools --no-ask-user -p "Use .llm-mem\context-pack.json as source-grounded context, then fix the task."
```

Diagnostic non-interactive workflow:

```powershell
node apps\cli\dist\index.js copilot run "Fix the cache invalidation bug" --budget 8000 --model gpt-5.5
```

Use `--dry-run` to inspect generated prompt artifacts without invoking Copilot:

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
