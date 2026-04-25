# Benchmark transparency

This document explains the live Copilot CLI benchmark result published in `README.md`.

## Current headline

After retrieval and prompt improvements, the same live benchmark that previously failed now shows **22.7% fewer mean Copilot tokens** for `llm-mem-context` on this task.

Across five repeated live runs per variant:

- `baseline-copilot` averaged **229,377.8** total Copilot tokens.
- `llm-mem-context` averaged **177,201.0** total Copilot tokens.
- Mean token savings were **22.7%**.
- Both variants completed successfully in **5/5** runs.
- `llm-mem-context` context recall for the gold file improved to **1.0**.

This is still one local read-only benchmark, not universal proof of product value. It does show that the original failure mode was fixable: the context pack now cites the intended implementation file and is much smaller.

## What changed after the failed run

The first published run showed a **23.9% token regression** because the context pack added prompt weight while missing the intended gold file, `packages/core/src/context-compiler.ts`.

The recovery changes targeted that root cause:

- Added TypeScript/JavaScript symbol indexing.
- Added identifier normalization such as `ContextCompiler` -> `context compiler` -> `context-compiler`.
- Added symbol/path/chunk hybrid retrieval scoring.
- Added match reasons and token-cost-aware candidates.
- Added compact explicit prompt rendering that removes duplicate task/citation/debug metadata.
- Lowered default context budgets from 8k/12k to 4k.
- Added MCP `context_map` and `snippet` tools for a map-first JIT flow, though this benchmark still measures explicit context injection.

Dry-run recall before the final live rerun:

| Variant | Prompt estimate | Context estimate | Gold-file recall |
| --- | ---: | ---: | ---: |
| `baseline-copilot` | 86 | 0 | 0.00 |
| `llm-mem-context` | 2,606 | 2,196 | 1.00 |

## What was measured

The benchmark compared two non-interactive Copilot CLI variants:

| Variant | Meaning |
| --- | --- |
| `baseline-copilot` | Copilot CLI received the task prompt only. |
| `llm-mem-context` | Copilot CLI received the same task plus a generated llm-mem context pack. |

The benchmark task was read-only:

```text
Explain how llm-mem's ContextCompiler builds a context pack, identify the main files involved, and list the validation command for its tests. Do not edit files.
```

Benchmark suite:

```text
evals\benchmarks\context-compiler-live.json
```

Exact command:

```powershell
node apps\cli\dist\index.js benchmark run evals\benchmarks\context-compiler-live.json --repeat 5 --token-source otel --no-worktree --model gpt-5.5
```

Each benchmark run executes **10 live Copilot CLI sessions** total:

- 5 `baseline-copilot`
- 5 `llm-mem-context`

## Token source

Copilot CLI was run with file-based OpenTelemetry export enabled for each run:

```powershell
$env:COPILOT_OTEL_ENABLED = "true"
$env:COPILOT_OTEL_EXPORTER_TYPE = "file"
$env:COPILOT_OTEL_FILE_EXPORTER_PATH = "<run-artifact>\copilot-otel.jsonl"
```

The parser records token and cost attributes from OTel `chat` spans:

- `gen_ai.usage.input_tokens`
- `gen_ai.usage.output_tokens`
- `gen_ai.usage.reasoning.output_tokens`
- `github.copilot.cost`

The headline result uses:

```text
total tokens = input tokens + output tokens
```

Reasoning output tokens are reported separately in per-run artifacts but are not added again to total tokens because they are represented as a subcategory of output tokens in the exported span attributes.

## Formula

```text
savings = (baseline_mean_total_tokens - llm_mem_mean_total_tokens) / baseline_mean_total_tokens * 100
```

For the improved run:

```text
(229,377.8 - 177,201.0) / 229,377.8 * 100 = 22.7471%
```

So the current result is reported as **22.7% mean token savings**.

## Improved run

| Field | Value |
| --- | --- |
| Date | 2026-04-25 |
| OS | Windows_NT |
| Copilot CLI version | 1.0.36 |
| Model | `gpt-5.5` |
| Token source | Copilot CLI OpenTelemetry JSONL |
| Report ID | `95b9b740-a98a-4141-bfaa-453d839e3212` |
| Local artifact directory | `.llm-mem\benchmarks\ec9b1d14-4056-41b3-a507-33b8f1c60da7` |

Per-run values:

| Repetition | Variant | Success | Total tokens | Input tokens | Output tokens | Prompt estimate | Context estimate | Context recall | Duration ms |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | `baseline-copilot` | yes | 311,484 | 307,085 | 4,399 | 86 | 0 | 0.00 | 84,613 |
| 1 | `llm-mem-context` | yes | 140,700 | 138,454 | 2,246 | 2,606 | 2,196 | 1.00 | 50,489 |
| 2 | `baseline-copilot` | yes | 202,816 | 199,444 | 3,372 | 86 | 0 | 0.00 | 78,610 |
| 2 | `llm-mem-context` | yes | 205,527 | 202,183 | 3,344 | 2,606 | 2,196 | 1.00 | 67,683 |
| 3 | `baseline-copilot` | yes | 283,694 | 279,776 | 3,918 | 86 | 0 | 0.00 | 72,303 |
| 3 | `llm-mem-context` | yes | 140,889 | 138,715 | 2,174 | 2,606 | 2,196 | 1.00 | 76,609 |
| 4 | `baseline-copilot` | yes | 172,293 | 169,478 | 2,815 | 86 | 0 | 0.00 | 75,664 |
| 4 | `llm-mem-context` | yes | 187,698 | 184,764 | 2,934 | 2,606 | 2,196 | 1.00 | 59,045 |
| 5 | `baseline-copilot` | yes | 176,602 | 173,889 | 2,713 | 86 | 0 | 0.00 | 57,106 |
| 5 | `llm-mem-context` | yes | 211,191 | 208,281 | 2,910 | 2,606 | 2,196 | 1.00 | 61,541 |

Aggregate values:

| Metric | `baseline-copilot` | `llm-mem-context` | Delta |
| --- | ---: | ---: | ---: |
| Mean total tokens | 229,377.8 | 177,201.0 | 22.7% fewer |
| Mean input tokens | 225,934.4 | 174,479.4 | 22.8% fewer |
| Mean output tokens | 3,443.4 | 2,721.6 | 21.0% fewer |
| Successful runs | 5/5 | 5/5 | equal |
| Mean context recall | 0.00 | 1.00 | improved |
| Mean prompt estimate | 86 | 2,606 | 2,520 more upfront |
| Mean duration | 73,659.2 ms | 63,073.4 ms | 14.4% faster |

Important caveat: this is a mean improvement, not a per-run guarantee. In repetitions 2, 4, and 5, `llm-mem-context` used more total tokens than `baseline-copilot`; the mean improved because repetitions 1 and 3 saved substantially more tokens.

## Original failed run

The original run is preserved because it is the reason these changes were made.

| Field | Value |
| --- | --- |
| Date | 2026-04-25 |
| OS | Windows_NT |
| Copilot CLI version | 1.0.36 |
| Model | `gpt-5.5` |
| Token source | Copilot CLI OpenTelemetry JSONL |
| Report ID | `b5d02f89-2fce-4ba6-bcc0-a563567f9174` |
| Local artifact directory | `.llm-mem\benchmarks\3a7fe861-a770-4255-b3a5-b766a383ce87` |

Original per-run values:

| Repetition | Variant | Success | Total tokens | Input tokens | Output tokens | Duration ms |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | `baseline-copilot` | yes | 170,003 | 167,086 | 2,917 | 61,636 |
| 1 | `llm-mem-context` | yes | 304,280 | 300,939 | 3,341 | 71,536 |
| 2 | `baseline-copilot` | yes | 197,378 | 194,305 | 3,073 | 64,734 |
| 2 | `llm-mem-context` | yes | 320,304 | 317,343 | 2,961 | 130,645 |
| 3 | `baseline-copilot` | yes | 334,309 | 330,359 | 3,950 | 79,480 |
| 3 | `llm-mem-context` | yes | 321,379 | 317,605 | 3,774 | 81,071 |
| 4 | `baseline-copilot` | yes | 235,965 | 233,202 | 2,763 | 60,475 |
| 4 | `llm-mem-context` | yes | 264,671 | 261,054 | 3,617 | 80,167 |
| 5 | `baseline-copilot` | yes | 282,121 | 278,401 | 3,720 | 89,005 |
| 5 | `llm-mem-context` | yes | 301,160 | 297,943 | 3,217 | 72,639 |

Original aggregate values:

| Metric | `baseline-copilot` | `llm-mem-context` | Delta |
| --- | ---: | ---: | ---: |
| Mean total tokens | 243,955.2 | 302,358.8 | 23.9% more |
| Mean input tokens | 240,670.6 | 298,976.8 | 24.2% more |
| Mean output tokens | 3,284.6 | 3,382.0 | 3.0% more |
| Successful runs | 5/5 | 5/5 | equal |
| Mean context recall | 0.00 | 0.00 | no improvement |
| Mean duration | 71,066.0 ms | 87,211.6 ms | 22.7% slower |

## Interpretation

The current result supports a narrower claim:

> For this one read-only `ContextCompiler` benchmark in this repository, symbol/path-aware retrieval plus compact prompt rendering reduced mean live Copilot CLI token usage while preserving the benchmark's quality gate.

It does **not** prove broad token savings across all repositories or task types. The next credible step is a recovery suite with more task classes, including edits with failing tests, architecture questions, test-location tasks, and negative controls where llm-mem should abstain or return a tiny map.

## Limitations

- This is one local read-only task in one repository, not a broad benchmark.
- The 22.7% value is an average across five repetitions; three paired repetitions still used more tokens with `llm-mem-context`.
- The before/after runs were made against different code revisions, so they show product recovery rather than a same-binary A/B comparison.
- The result reflects this machine's Copilot CLI environment, including available tools, skills, MCP servers, and model behavior on the run date.
- The benchmark compares non-interactive prompt mode, not an interactive human-guided session.
- The `llm-mem-context` variant still uses explicit context-pack prompt injection; the new map-first MCP JIT flow should be benchmarked separately.
- Token usage comes from Copilot CLI OpenTelemetry spans, not billing invoices.
- Token savings only count if quality remains equal or better; this benchmark used a basic quality gate plus context recall, not a human review rubric.
