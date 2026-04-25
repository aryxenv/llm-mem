# ADR-003: GPT-5.5 preferred model policy

## Status

Accepted.

## Decision

Use a provider-neutral model abstraction, but make GPT-5.5 the preferred model for high-quality reasoning, planning, compression, review, and complex coding when available.

## Rationale

The project prioritizes quality and source-grounded decisions. Hard-coding one provider would make the system brittle as assistant ecosystems change, but model policy should still express the quality preference.

## Consequences

- Skills and agents declare model policies.
- Lower-cost models may be configured for deterministic or low-risk work, but must not silently replace GPT-5.5 for quality-critical steps.
