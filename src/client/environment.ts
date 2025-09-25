import type { OriginalEnv } from "./step.js";

type GenerationState = { now: number; latest: boolean };

export function setupEnvironment(
  getGenerationState: () => GenerationState,
): OriginalEnv {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const global = globalThis as any;

  global.Math.random = () => {
    throw new Error("Math.random() isn't currently supported within workflows");
  };

  const originalDate = global.Date;
  delete global.Date;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function Date(this: any, ...args: any[]) {
    // `Date()` was called directly, not as a constructor.
    if (!(this instanceof Date)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const date = new (Date as any)();
      return date.toString();
    }
    if (args.length === 0) {
      const unixTsMs = Date.now();
      return new originalDate(unixTsMs);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new (originalDate as any)(...args);
  }
  Date.now = function () {
    const { now } = getGenerationState();
    return now;
  };
  Date.parse = originalDate.parse;
  Date.UTC = originalDate.UTC;
  Date.prototype = originalDate.prototype;
  Date.prototype.constructor = Date;

  global.Date = Date;
  global.console = createConsole(global.console, getGenerationState);

  delete global.process;

  delete global.Crypto;
  delete global.crypto;
  delete global.CryptoKey;
  delete global.SubtleCrypto;

  global.fetch = (_input: RequestInfo | URL, _init?: RequestInit) => {
    throw new Error(
      `Fetch isn't currently supported within workflows. Perform the fetch within an action and call it with step.runAction().`,
    );
  };
  return { Date: originalDate };
}

function noop() {}

function createConsole(
  console: Console,
  getGenerationState: () => GenerationState,
): Console {
  const counts: Record<string, number> = {};
  const times: Record<string, number> = {};
  return new Proxy(console, {
    get: (target, prop) => {
      const { now, latest } = getGenerationState();
      switch (prop) {
        case "assert":
        case "clear":
        case "debug":
        case "dir":
        case "dirxml":
        case "error":
        case "info":
        case "log":
        case "table":
        case "trace":
        case "warn":
        case "profile":
        case "profileEnd":
        case "timeStamp":
          if (!latest) {
            return noop;
          }
          return target[prop];
        case "Console":
          throw new Error(
            "console.Console() is not supported within workflows",
          );
        case "count":
          return (label?: string) => {
            const key = label ?? "default";
            counts[key] = (counts[key] ?? 0) + 1;
            if (latest) {
              target.info(`${key}: ${counts[key]}`);
            }
          };
        case "countReset":
          return (label?: string) => {
            const key = label ?? "default";
            counts[key] = 0;
          };
        case "group":
        case "groupCollapsed":
          if (!latest) {
            // Don't print anything if latest is false
            return () => target.group();
          }
          return target[prop];
        case "time":
          if (!latest) {
            return (label?: string) => {
              times[label ?? "default"] = now;
            };
          }
          return target[prop];
        case "timeEnd":
        case "timeLog":
          if (!latest) {
            return noop;
          }
          return (label?: string, ...data: unknown[]) => {
            const key = label ?? "default";
            if (times[key] === undefined) {
              target[prop](label);
            } else {
              target.info(`${key}: ${now - times[key]}ms`, ...data);
            }
          };
        // passes through
        case "groupEnd":
          return target[prop];
      }
      return target[prop as keyof Console];
    },
  });
}
