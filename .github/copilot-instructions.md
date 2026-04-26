# Copilot instructions for llm-mem

## Commands

- Install dependencies: `npm install`
- Build all TypeScript project references: `npm run build`
- Typecheck without pretty output: `npm run typecheck`
- Run the default test suite: `npm test`
- Run build/typecheck plus tests: `npm run check`
- Run one test file: `npx vitest run tests\context-compiler.test.ts`
- Run one test by name: `npx vitest run tests\mcp-server.test.ts -t "returns a compact context_map"`
- Run optional live Copilot smoke tests: `$env:LLM_MEM_LIVE_COPILOT=1; npm run test:live`
- Start development entry points: `npm run dev:cli -- <command>`, `npm run dev:daemon`, `npm run dev:mcp`
- Run a dry benchmark: `npm run dev:cli -- benchmark run evals\benchmarks\smoke.json --dry-run`
- Link the local CLI after building: `npm run link:cli`

## Architecture

`llm-mem` is a local-first Context Compiler for coding agents. It indexes repository structure into a local SQLite store, retrieves task-relevant source-grounded candidates, and emits compact context maps, snippets, or proof-carrying context packs rather than replacing the coding assistant.

The root is an npm workspace with strict TypeScript project references. `packages\core` defines shared types, token budgeting, and `ContextCompiler`; `packages\storage` implements `SQLiteStore` for repos, files, chunks, symbols, memories, tasks, context packs, worktree leases, and benchmark records; `packages\indexer` scans repositories, applies ignore rules, redacts secrets, chunks files, and extracts TypeScript/JavaScript symbols.

Runtime surfaces live under `apps`. `apps\cli` wires user commands such as `init`, `index`, `context`, `remember`, `task`, `worktree`, `copilot`, `benchmark`, `eval`, `daemon`, and `mcp`; `apps\daemon` exposes a local HTTP API on `127.0.0.1` with a bearer token stored under `.llm-mem`; `apps\mcp-server` exposes JSON-RPC stdio tools including `llm_mem_context_map`, `llm_mem_snippet`, `llm_mem_context_pack`, `llm_mem_remember`, and `llm_mem_worktree_create`.

Copilot integration is handled by `packages\integrations`. Install preserves existing `.mcp.json` servers, creates `.llm-memignore` only when absent, writes generated skill/instruction guidance, and refuses to overwrite a custom llm-mem skill. The intended Copilot flow is map-first: call `llm_mem_context_map`, expand only needed candidates with `llm_mem_snippet`, and reserve `llm_mem_context_pack` for broad or debugging tasks.

Benchmarks and evals are first-class product validation. `packages\benchmarks` compares `baseline-copilot` against `llm-mem-context`, can use isolated git worktrees for live runs, and writes reports under `.llm-mem\benchmarks\...`; `packages\evals` scores context packs for token use and context recall against gold files.

## Conventions

- Use Node.js `>=24` and TypeScript ESM (`"type": "module"`, `moduleResolution: "NodeNext"`). Source files use `.js` extensions in relative imports so compiled ESM paths are valid.
- Keep package public APIs routed through `src\index.ts` and workspace imports such as `@llm-mem/core`; Vitest aliases those package names to source entry points.
- The compiler and MCP surfaces should preserve citations. Durable facts and memories should include source refs, trust level, confidence, and freshness where applicable.
- External input boundaries use Zod schemas from `@llm-mem/protocol`; keep validation near CLI, daemon, and MCP request handling.
- With `exactOptionalPropertyTypes` enabled, prefer conditional spreads that omit absent optional fields instead of setting properties to `undefined`.
- Indexing and logging must keep using `@llm-mem/security` helpers: respect `.gitignore` plus `.llm-memignore`, skip generated/sensitive paths, and redact secrets before storage, logging, or model-facing output.
- Repo-internal indexed paths and citations are normalized with `/` even when CLI examples use Windows-style paths.
- Worktree operations are intentionally conservative: creating a lease requires a clean base by default, and releasing a dirty worktree requires explicit opt-in.
- Token savings are not a success metric by themselves; benchmark and eval changes should keep quality, resolved status, or context recall equal or better.
