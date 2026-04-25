# Security posture

`llm-mem` is local-first and treats repository content, external documents, and model output as untrusted unless grounded by source refs.

## Defaults

- Do not bind local APIs to public interfaces.
- Require a local auth token for HTTP APIs.
- Redact secrets before indexing, logging, or model calls.
- Respect `.gitignore` and `.llm-memignore`.
- Keep prompt and source logging redacted by default.
- Never delete dirty worktrees automatically.
- Never rewrite history, force-push, or delete branches without explicit approval.

## Plugin permissions

Plugins and skills declare permissions such as `read_repo`, `write_repo`, `read_memory`, `write_memory`, `network`, `execute_shell`, `manage_worktrees`, and `call_model`. Dangerous permissions must be explicit in the manifest and visible in traces.
