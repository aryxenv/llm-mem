# llm-mem

`llm-mem` is a local-first **Context Compiler** for token-efficient coding agents. It does not replace tools like Copilot CLI, Claude Code, Codex, or OpenCode. Instead, it gives them compact, source-grounded context packs so they can reason with less repeated context and fewer wasted tokens.

The thesis: token waste is usually caused by repeated discovery, stale summaries, duplicated agent work, and unproven context sufficiency. `llm-mem` attacks those causes with structural indexing, proof-carrying context packs, semantic patch memory, worktree orchestration, and evaluation-driven optimization.

## Initial surfaces

- CLI for local workflows.
- Local daemon for shared memory and indexing.
- MCP-compatible JSON-RPC server for coding tools.
- SQLite-backed memory and retrieval.
- Git worktree leases for safe parallel agent work.

## Development

```powershell
npm install
npm run build
npm test
```

## Status

This repository is in early implementation. The first milestone is a working local MVP that can index a repo, store source-grounded memory, produce context packs, expose CLI/MCP surfaces, manage safe worktree leases, and measure token savings against quality.
