# ADR-002: Runtime and storage

## Status

Accepted.

## Decision

Use TypeScript/Node.js as the primary runtime and SQLite as the primary durable store.

## Rationale

TypeScript fits CLI tooling, JSON-RPC/MCP, schemas, plugins, and editor-adjacent integrations. SQLite fits local-first metadata, event logs, full-text search, and simple deployment. SQLite FTS5 provides efficient local search without adding an external service.

## Consequences

- Rust can be added later for hot paths such as parsing or indexing.
- DuckDB can be added later for offline evaluation analytics.
- The storage layer must keep vector search behind an interface.
