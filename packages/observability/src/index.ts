import { redactSecrets } from "@llm-mem/security";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  level: LogLevel;
  message: string;
  attributes?: Record<string, unknown>;
}

export interface Logger {
  log(event: LogEvent): void;
  debug(message: string, attributes?: Record<string, unknown>): void;
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
}

export class JsonLogger implements Logger {
  public constructor(private readonly minimumLevel: LogLevel = "info") {}

  public log(event: LogEvent): void {
    if (levelValue(event.level) < levelValue(this.minimumLevel)) {
      return;
    }

    const redactedMessage = redactSecrets(event.message).text;
    const payload = {
      timestamp: new Date().toISOString(),
      level: event.level,
      message: redactedMessage,
      attributes: event.attributes ?? {}
    };
    const output = JSON.stringify(payload);

    if (event.level === "error") {
      console.error(output);
      return;
    }

    console.log(output);
  }

  public debug(message: string, attributes?: Record<string, unknown>): void {
    this.log({ level: "debug", message, ...(attributes === undefined ? {} : { attributes }) });
  }

  public info(message: string, attributes?: Record<string, unknown>): void {
    this.log({ level: "info", message, ...(attributes === undefined ? {} : { attributes }) });
  }

  public warn(message: string, attributes?: Record<string, unknown>): void {
    this.log({ level: "warn", message, ...(attributes === undefined ? {} : { attributes }) });
  }

  public error(message: string, attributes?: Record<string, unknown>): void {
    this.log({ level: "error", message, ...(attributes === undefined ? {} : { attributes }) });
  }
}

export async function traceAsync<T>(
  logger: Logger,
  name: string,
  fn: () => Promise<T>,
  attributes: Record<string, unknown> = {}
): Promise<T> {
  const startedAt = performance.now();
  logger.debug(`${name}.start`, attributes);

  try {
    const result = await fn();
    logger.debug(`${name}.finish`, { ...attributes, durationMs: performance.now() - startedAt });
    return result;
  } catch (error) {
    logger.error(`${name}.error`, {
      ...attributes,
      durationMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

function levelValue(level: LogLevel): number {
  switch (level) {
    case "debug":
      return 10;
    case "info":
      return 20;
    case "warn":
      return 30;
    case "error":
      return 40;
  }
}
