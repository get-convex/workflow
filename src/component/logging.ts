import { v, Infer } from "convex/values";

export const DEFAULT_LOG_LEVEL: LogLevel = "WARN";

// NOTE: the ordering here is important! A config level of "INFO" will log
// "INFO", "REPORT", "WARN",and "ERROR" events.
export const logLevel = v.union(
  v.literal("DEBUG"),
  v.literal("TRACE"),
  v.literal("INFO"),
  v.literal("REPORT"),
  v.literal("WARN"),
  v.literal("ERROR"),
);
export type LogLevel = Infer<typeof logLevel>;

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

const logLevelOrder = logLevel.members.map((l) => l.value);
const logLevelByName = logLevelOrder.reduce(
  (acc, l, i) => {
    acc[l] = i;
    return acc;
  },
  {} as Record<LogLevel, number>,
);
export function shouldLog(config: LogLevel, level: LogLevel) {
  return logLevelByName[config] <= logLevelByName[level];
}
const DEBUG = logLevelByName["DEBUG"];
const TRACE = logLevelByName["TRACE"];
const INFO = logLevelByName["INFO"];
const REPORT = logLevelByName["REPORT"];
const WARN = logLevelByName["WARN"];
const ERROR = logLevelByName["ERROR"];

export function createLogger(level?: LogLevel): Logger {
  const logLevel = level ?? DEFAULT_LOG_LEVEL;
  const levelIndex = logLevelByName[logLevel];
  if (levelIndex === undefined) {
    throw new Error(`Invalid log level: ${logLevel}`);
  }
  return {
    logLevel,
    debug: (...args: unknown[]) => {
      if (levelIndex <= DEBUG) {
        console.debug(...args);
      }
    },
    log: (...args: unknown[]) => {
      if (levelIndex <= INFO) {
        console.log(...args);
      }
    },
    info: (...args: unknown[]) => {
      if (levelIndex <= INFO) {
        console.info(...args);
      }
    },
    warn: (...args: unknown[]) => {
      if (levelIndex <= WARN) {
        console.warn(...args);
      }
    },
    error: (...args: unknown[]) => {
      if (levelIndex <= ERROR) {
        console.error(...args);
      }
    },
    time: (label: string) => {
      if (levelIndex <= TRACE) {
        console.time(label);
      }
    },
    timeEnd: (label: string) => {
      if (levelIndex <= TRACE) {
        console.timeEnd(label);
      }
    },
    event: (event: string, payload: Record<string, unknown>) => {
      const fullPayload = {
        component: "workflow",
        event,
        ...payload,
      };
      if (levelIndex === REPORT && event === "report") {
        console.info(JSON.stringify(fullPayload));
      } else if (levelIndex <= INFO) {
        console.info(JSON.stringify(fullPayload));
      }
    },
  };
}
