# ADR-001: Context Compiler architecture

## Status

Accepted.

## Context

Coding assistants burn tokens by repeatedly rediscovering project facts, reading broad file context, carrying stale summaries, and mixing unrelated agent work. Shorter prose is not enough because it can reduce reasoning quality.

Anthropic frames context engineering as curating and maintaining the optimal set of tokens during inference. MCP provides a standard way to connect assistants to tools and workflows. Git worktrees allow multiple isolated working trees over one repository. SQLite provides simple and reliable local application storage.

## Decision

Build `llm-mem` as a local-first Context Compiler. It compiles task intent, code structure, memory, source refs, prior patches, and token budgets into proof-carrying context packs.

## Consequences

- The main product output is a context pack, not a chat transcript.
- Existing coding assistants remain the execution layer.
- Every durable fact should carry provenance, freshness, and confidence.
- Token savings must be measured against task quality.
