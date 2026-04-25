# Benchmark transparency

This document explains the first published live benchmark result in `README.md`.

## Headline

In this benchmark, `llm-mem` did **not** reduce Copilot CLI token usage.

Across five repeated live runs per variant:

- `baseline-copilot` averaged **243,955.2** total Copilot tokens.
- `llm-mem-context` averaged **302,358.8** total Copilot tokens.
- Token savings were **-23.9%**, meaning `llm-mem-context` used **23.9% more** tokens than baseline.
- Both variants completed successfully in **5/5** runs.

This is a negative benchmark result. It is included because token-saving claims should be measured and falsifiable.

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

## Exact command

Run from the repository root:

```powershell
node apps\cli\dist\index.js benchmark run evals\benchmarks\context-compiler-live.json --repeat 5 --token-source otel --no-worktree --model gpt-5.5
```

The benchmark ran **10 live Copilot CLI sessions** total:

- 5 `baseline-copilot`
- 5 `llm-mem-context`

## Environment

| Field | Value |
| --- | --- |
| Date | 2026-04-25 |
| OS | Windows_NT |
| Copilot CLI version | 1.0.36 |
| Model | `gpt-5.5` |
| Token source | Copilot CLI OpenTelemetry JSONL |
| Report ID | `b5d02f89-2fce-4ba6-bcc0-a563567f9174` |
| Local artifact directory | `.llm-mem\benchmarks\3a7fe861-a770-4255-b3a5-b766a383ce87` |

Raw artifacts are under `.llm-mem\benchmarks\...`, which is intentionally gitignored. The measured values are copied below so the published result is reviewable without those local artifacts.

## Token source

Copilot CLI was run with file-based OpenTelemetry export enabled for each run:

```powershell
$env:COPILOT_OTEL_ENABLED = "true"
$env:COPILOT_OTEL_EXPORTER_TYPE = "file"
$env:COPILOT_OTEL_FILE_EXPORTER_PATH = "<run-artifact>\copilot-otel.jsonl"
```

The parser recorded token and cost attributes from OTel `chat` spans:

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

For this run:

```text
(243,955.2 - 302,358.8) / 243,955.2 * 100 = -23.9403%
```

So the result is reported as **-23.9% token savings**, or a **23.9% token regression**.

## Per-run results

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

Aggregate values from the benchmark report:

| Metric | `baseline-copilot` | `llm-mem-context` | Delta |
| --- | ---: | ---: | ---: |
| Mean total tokens | 243,955.2 | 302,358.8 | 23.9% more |
| Mean input tokens | 240,670.6 | 298,976.8 | 24.2% more |
| Mean output tokens | 3,284.6 | 3,382.0 | 3.0% more |
| Successful runs | 5/5 | 5/5 | equal |
| Mean duration | 71,066.0 ms | 87,211.6 ms | 22.7% slower |

## Interpretation

This benchmark shows that the current explicit context-pack path is not yet a proven token saver for this task.

The likely cause is visible in the generated context pack: it added a large prompt context but did not cite the intended gold file, `packages/core/src/context-compiler.ts`. The benchmark therefore found a product gap:

- the context pack increased prompt size,
- Copilot still had to reason and inspect context,
- and the generated pack missed the most relevant file for this task.

This result supports continuing work on retrieval precision, context-pack size control, and measuring the installed MCP/skill flow separately from the explicit prompt-injection flow.

## Limitations

- This is one local read-only task in one repository, not a broad benchmark.
- The result reflects this machine's Copilot CLI environment, including available tools, skills, MCP servers, and model behavior on the run date.
- The benchmark compares non-interactive prompt mode, not an interactive human-guided session.
- The `llm-mem-context` variant uses explicit context-pack prompt injection; future installed MCP/skill behavior may have different token dynamics.
- Token usage comes from Copilot CLI OpenTelemetry spans, not billing invoices.
- The benchmark should be repeated after retrieval and context-budget improvements.
