export interface RedactionResult {
  text: string;
  redactionCount: number;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bghp_[A-Za-z0-9_]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:sk|pk|rk)_(?:live|test|proj)_[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g
];

export function redactSecrets(input: string): RedactionResult {
  let redactionCount = 0;
  let text = input;

  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      redactionCount += 1;
      return "[REDACTED_SECRET]";
    });
  }

  return { text, redactionCount };
}
