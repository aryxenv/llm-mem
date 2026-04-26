# llm-mem

`llm-mem` is a local-first **Context Compiler** for token-efficient coding agents. It does not replace tools like Copilot CLI, Claude Code, Codex, or OpenCode. Instead, it gives them compact, source-grounded context packs so they can reason with less repeated context and fewer wasted tokens.

The thesis: token waste is usually caused by repeated discovery, stale summaries, duplicated agent work, and unproven context sufficiency. `llm-mem` attacks those causes with structural indexing, proof-carrying context packs, semantic patch memory, worktree orchestration, and evaluation-driven optimization.

Copilot CLI benchmark showed **22.7% fewer mean Copilot tokens**.

> [!NOTE]
> Currently only supporting **Copilot CLI**.

## Initial surfaces

- CLI for local workflows.
- Local daemon for shared memory and indexing.
- MCP-compatible JSON-RPC server for coding tools.
- SQLite-backed memory and retrieval.
- Git worktree leases for safe parallel agent work.

## Quickstart

Most coding-agent token waste comes from rediscovering project structure: reading the same files, re-learning conventions, restating prior decisions, and dumping broad context because the agent cannot prove which small slice is enough. `llm-mem` reduces that waste by indexing the repo once and compiling a task-specific, source-grounded context pack before the coding agent starts.

The intended user experience is install-and-forget: install the `llm-mem` CLI once for your user/machine, opt in each repository explicitly, then keep launching Copilot CLI normally.

| Layer                                                  | Scope             | What it does                                                                   |
| ------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------ |
| `llm-mem` CLI                                          | Global/user-level | Makes the `llm-mem` command available on PATH for any repo.                    |
| `.llm-mem/` index                                      | Project-specific  | Stores that repo's local SQLite index, context packs, and benchmark artifacts. |
| `.vscode\mcp.json` + `.github\skills\llm-mem\SKILL.md` | Project-specific  | Opts that repo into Copilot + `llm-mem` integration.                           |
| `copilot` command                                      | Unchanged         | You still start Copilot normally; no PATH hijack or replacement binary.        |

Install the CLI once from this source checkout:

```powershell
npm install
npm run build
npm run link:cli
```

Then, once per project you want Copilot to optimize:

```powershell
llm-mem integrate copilot install
copilot
```

That is the normal flow. You keep typing `copilot`; `llm-mem` is available underneath through MCP and a small project skill.

`llm-mem integrate copilot install`:

1. Initializes and indexes the repository.
2. Adds a project-local `.vscode\mcp.json` entry for the `llm-mem` MCP server.
3. Adds `.github\skills\llm-mem\SKILL.md`, a lean skill with the exact MCP call shape, context-pack usage rules, fallback behavior, and anti-patterns.
4. Leaves `.github\copilot-instructions.md` untouched by default so org/team instruction files stay clean.
5. Preserves the existing Copilot CLI flow; no PATH hijacking or replacement `copilot` binary is required.

Inspect or remove the integration:

```powershell
llm-mem integrate copilot status
llm-mem integrate copilot uninstall
```

Use `--dry-run` to preview file changes without writing, and `--skip-index` if you do not want install to index immediately. If your Copilot environment does not load project skills yet, install a tiny marked block in the instruction file instead:

```powershell
llm-mem integrate copilot install --guidance instructions
```

Use `--guidance both` if you want both the clean project skill and the compatibility instruction block. The default is `--guidance skill`.

## How this helps in practice

Most coding-agent token waste comes from repeated discovery. `llm-mem` now attacks that with a map-first flow: Copilot can ask MCP for a compact list of likely files/symbols, then expand only the snippets it needs instead of receiving a large context dump upfront.

Primary Copilot flow after integration:

1. Start `copilot` normally.
2. For non-trivial repo tasks, the generated skill tells Copilot to call `llm_mem.context_map`.
3. Copilot expands only necessary candidates with `llm_mem.snippet`.
4. Full `llm_mem.context_pack` is reserved for broad/debug tasks where the compact map is insufficient.

Advanced/manual full-pack workflow:

```powershell
llm-mem context "Fix the cache invalidation bug" --budget 4000 > .llm-mem\context-pack.json

copilot --model gpt-5.5 --allow-all-tools --no-ask-user -p "Use .llm-mem\context-pack.json as source-grounded context, then fix the task."
```

Diagnostic non-interactive workflow:

```powershell
llm-mem copilot run "Fix the cache invalidation bug" --budget 4000 --model gpt-5.5
```

Use `--dry-run` to inspect generated prompt artifacts without invoking Copilot:

```powershell
llm-mem copilot run "Explain the ContextCompiler" --dry-run
```

Artifacts are written under `.llm-mem/runs/`.

## Benchmarking the value

Unit tests only prove the implementation works. They do not prove the token-efficiency thesis. For that, use A/B benchmark runs.

**Current live benchmark result:** This repo's 5-run Copilot CLI benchmark showed **22.7% fewer mean Copilot tokens** with `llm-mem-context`. `baseline-copilot` averaged **229,378** total Copilot tokens, while `llm-mem-context` averaged **177,201**, with both variants completing successfully in **5/5** runs. The first run of this same benchmark had regressed by 23.9%; see [TRANSPARENCY.md](TRANSPARENCY.md) for the full before/after method, raw numbers, and limitations.

The compared variants are:

- `baseline-copilot`: Copilot CLI receives only the task prompt.
- `llm-mem-context`: Copilot CLI receives the task prompt plus a generated context pack.

Run a deterministic dry benchmark:

```powershell
llm-mem benchmark list
llm-mem benchmark run evals\benchmarks\smoke.json --dry-run
```

Run live Copilot CLI after reviewing the suite:

```powershell
llm-mem benchmark run evals\benchmarks\smoke.json --model gpt-5.5
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

## Contributions

Contributions are welcome! This repository is in early implementation. The first milestone is a working local MVP that can index a repo, store source-grounded memory, produce context packs, expose CLI/MCP surfaces, manage safe worktree leases, and measure token savings against quality. The next focus is credible live benchmarking against Copilot CLI and SWE-bench-style task suites.
