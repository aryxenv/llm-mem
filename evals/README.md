# Evaluations

Evaluation suites compare token use against quality. Baselines should include no memory, full-context, retrieval-only, summarization-only, and `llm-mem` context packs.

Initial metrics:

- token budget used
- context compression ratio
- retrieval precision and recall
- answer correctness
- patch/test success
- hallucinated repo-claim rate
- long-session endurance

## Benchmark tiers

1. **Smoke suites** validate instrumentation and report generation.
2. **Pinned public-repo fixtures** validate repeatable task execution on real code.
3. **SWE-bench Lite/Verified subset manifests** provide externally recognizable software-engineering benchmark tasks.

Use `baseline-copilot` versus `llm-mem-context` as the first A/B comparison. Do not claim success from lower token use alone; quality must stay equal or improve.
