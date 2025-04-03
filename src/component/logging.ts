import { v, Infer } from "convex/values";

export const DEFAULT_LOG_LEVEL: LogLevel = "WARN";

export type Logger = {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  time: (label: string) => void;
  timeEnd: (label: string) => void;
  event: (event: string, payload: Record<string, unknown>) => void;
  logLevel: LogLevel;
};

export function createLogger(level?: LogLevel): Logger {
  const logLevel = level ?? DEFAULT_LOG_LEVEL;
  const levelIndex = ["DEBUG", "INFO", "WARN", "ERROR"].indexOf(logLevel);
  if (levelIndex === -1) {
    throw new Error(`Invalid log level: ${level}`);
  }
  return {
    debug: (...args: unknown[]) => {
      if (levelIndex <= 0) {
        console.debug(...args);
      }
    },
    log: (...args: unknown[]) => {
      if (levelIndex <= 1) {
        console.info(...args);
      }
    },
    info: (...args: unknown[]) => {
      if (levelIndex <= 1) {
        console.info(...args);
      }
    },
    warn: (...args: unknown[]) => {
      if (levelIndex <= 2) {
        console.warn(...args);
      }
    },
    error: (...args: unknown[]) => {
      if (levelIndex <= 3) {
        console.error(...args);
      }
    },
    time: (label: string) => {
      if (levelIndex <= 0) {
        console.time(label);
      }
    },
    timeEnd: (label: string) => {
      if (levelIndex <= 0) {
        console.timeEnd(label);
      }
    },
    event: (event: string, payload: Record<string, unknown>) => {
      if (levelIndex <= 1) {
        const fullPayload = {
          event,
          ...payload,
        };
        console.info(JSON.stringify(fullPayload));
      }
    },
    logLevel,
  };
}
export const logLevel = v.union(
  v.literal("DEBUG"),
  v.literal("INFO"),
  v.literal("WARN"),
  v.literal("ERROR"),
);
export type LogLevel = Infer<typeof logLevel>;
