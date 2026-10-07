import { pino } from "pino";

/** One structured JSON logger for the whole process (HTTP, simulator, jobs). Secrets are redacted at the source. */
export function createLogger(level: string) {
  return pino({
    level,
    redact: ["req.headers.authorization", "req.headers.cookie", "*.apiKey", "*.LLM_API_KEY"],
  });
}
