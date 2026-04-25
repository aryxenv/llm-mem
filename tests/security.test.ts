import { describe, expect, it } from "vitest";
import { createDefaultIgnoreRules, redactSecrets } from "../packages/security/src/index.js";

describe("security utilities", () => {
  it("redacts common secret assignments", () => {
    const result = redactSecrets("API_KEY=super-secret-token");

    expect(result.redactionCount).toBeGreaterThan(0);
    expect(result.text).toContain("[REDACTED_SECRET]");
  });

  it("does not redact ordinary content hashes", () => {
    const hash = "e27c2a5307d8c73ebd5e537514bce0e35cbb9125cd0719be21aae16912a53ef6";
    const result = redactSecrets(hash);

    expect(result.redactionCount).toBe(0);
    expect(result.text).toBe(hash);
  });

  it("ignores generated and sensitive paths", () => {
    const rules = createDefaultIgnoreRules();

    expect(rules.shouldIgnore("node_modules/pkg/index.js")).toBe(true);
    expect(rules.shouldIgnore(".env.local")).toBe(true);
    expect(rules.shouldIgnore("certs/dev.pem")).toBe(true);
    expect(rules.shouldIgnore("src/index.ts")).toBe(false);
  });
});
