type GenerationState = { now: number; latest: boolean };

type WorkflowEnvironment = {
  math: typeof Math;
  date: typeof Date;
  console: Console;
  fetch: typeof globalThis.fetch;
  setTimeout: typeof globalThis.setTimeout;
  setInterval: typeof globalThis.setInterval;
};

type AsyncLocalStorageLike<T> = {
  run<R>(store: T, callback: () => R): R;
  getStore(): T | undefined;
};

type AsyncLocalStorageConstructor = new <T>() => AsyncLocalStorageLike<T>;

let workflowEnvironmentStorage: AsyncLocalStorageLike<WorkflowEnvironment> | undefined;
let globalsPatched = false;

// Capture original globals before any patching occurs so createWorkflowEnvironment
// always wraps the true originals, even if called from within an active workflow context.
const originalGlobals = {
  Math: globalThis.Math,
  Date: globalThis.Date,
  console: globalThis.console,
};

function ensureWorkflowEnvironmentStorage() {
  if (workflowEnvironmentStorage !== undefined) {
    return;
  }

  const global = globalThis as {
    AsyncLocalStorage?: AsyncLocalStorageConstructor;
  };
  if (global.AsyncLocalStorage === undefined) {
    throw new Error(
      "AsyncLocalStorage is not available in this runtime. Update convex-backend to a build with async_hooks support.",
    );
  }
  workflowEnvironmentStorage = new global.AsyncLocalStorage<WorkflowEnvironment>();
}

// Simple hash function to convert a string to a 32-bit seed
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash >>> 0; // Ensure unsigned
}

// A simple, fast seeded PRNG
// https://gist.github.com/tommyettinger/46a874533244883189143505d203312c?permalink_comment_id=4854318#gistcomment-4854318
function createSeededRandom(seed: number): () => number {
  return () => {
    seed = (seed + 0x9e3779b9) | 0;
    let t = Math.imul(seed ^ (seed >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

// Testable unit: patches Math object to use seeded random
export function patchMath(math: typeof Math, seed: string): typeof Math {
  const patchedMath = Object.create(Object.getPrototypeOf(math));

  // Copy all properties from original Math
  for (const key of Object.getOwnPropertyNames(math)) {
    if (key !== "random") {
      const descriptor = Object.getOwnPropertyDescriptor(math, key);
      if (descriptor) {
        Object.defineProperty(patchedMath, key, descriptor);
      }
    }
  }

  // Override random to use seeded PRNG
  const seededRandom = createSeededRandom(hashString(seed));
  patchedMath.random = seededRandom;

  return patchedMath;
}

// Testable unit: creates deterministic Date constructor
export function createDeterministicDate(
  originalDate: typeof Date,
  getGenerationState: () => GenerationState,
): typeof Date {
  function DeterministicDate(this: unknown, ...args: unknown[]) {
    // `Date()` was called directly, not as a constructor.
    if (!(this instanceof DeterministicDate)) {
      const date = new (DeterministicDate as typeof Date)();
      return date.toString();
    }
    if (args.length === 0) {
      const { now } = getGenerationState();
      return new originalDate(now) as unknown as Date;
    }
    return new (originalDate as typeof Date)(
      ...(args as ConstructorParameters<typeof Date>),
    ) as unknown as Date;
  }

  DeterministicDate.now = function () {
    const { now } = getGenerationState();
    return now;
  };
  DeterministicDate.parse = originalDate.parse;
  DeterministicDate.UTC = originalDate.UTC;
  DeterministicDate.prototype = originalDate.prototype;
  DeterministicDate.prototype.constructor = DeterministicDate as typeof Date;

  // TODO: Additional methods that should be patched for full determinism:
  // - getTimezoneOffset() - should return 0 (UTC)
  // - toLocaleString() - should use fixed locale (en-US) and UTC timezone
  // - toLocaleDateString() - should use fixed locale (en-US) and UTC timezone
  // - toLocaleTimeString() - should use fixed locale (en-US) and UTC timezone
  // These would require more complex prototype manipulation to work correctly.

  return DeterministicDate as typeof Date;
}

const unsupportedFetch: typeof globalThis.fetch = (
  _input: RequestInfo | URL,
  _init?: RequestInit,
) => {
  throw new Error(
    `Fetch isn't currently supported within workflows. Perform the fetch within an action and call it with step.runAction().`,
  );
};

const unsupportedSetTimeout = ((..._args: any[]) => {
  throw new Error("setTimeout isn't supported within workflows yet");
}) as unknown as typeof globalThis.setTimeout;

const unsupportedSetInterval = ((..._args: any[]) => {
  throw new Error("setInterval isn't supported within workflows yet");
}) as unknown as typeof globalThis.setInterval;

function defineWorkflowAwareGlobal<T>(
  globalObject: Record<string, unknown>,
  key: string,
  getWorkflowValue: (environment: WorkflowEnvironment) => T,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalObject, key);
  if (descriptor?.configurable === false) {
    return;
  }

  let outsideValue = globalObject[key] as T;
  Object.defineProperty(globalObject, key, {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    get() {
      const environment = workflowEnvironmentStorage?.getStore();
      if (environment !== undefined) {
        return getWorkflowValue(environment);
      }
      return outsideValue;
    },
    set(value: T) {
      outsideValue = value;
    },
  });
}

function createWorkflowEnvironment(
  getGenerationState: () => GenerationState,
  workflowId: string,
): WorkflowEnvironment {
  return {
    math: patchMath(originalGlobals.Math, workflowId),
    date: createDeterministicDate(originalGlobals.Date, getGenerationState),
    console: createConsole(originalGlobals.console, getGenerationState),
    fetch: unsupportedFetch,
    setTimeout: unsupportedSetTimeout,
    setInterval: unsupportedSetInterval,
  };
}

export function setupEnvironment(): void {
  if (globalsPatched) {
    return;
  }

  ensureWorkflowEnvironmentStorage();

  const global = globalThis as Record<string, unknown>;
  defineWorkflowAwareGlobal(global, "Math", (environment) => environment.math);
  defineWorkflowAwareGlobal(global, "Date", (environment) => environment.date);
  defineWorkflowAwareGlobal(global, "console", (environment) => environment.console);
  defineWorkflowAwareGlobal(global, "fetch", (environment) => environment.fetch);
  defineWorkflowAwareGlobal(global, "setTimeout", (environment) => environment.setTimeout);
  defineWorkflowAwareGlobal(global, "setInterval", (environment) => environment.setInterval);

  const restrictedGlobals = [
    "process",
    "Crypto",
    "crypto",
    "CryptoKey",
    "SubtleCrypto",
  ];
  for (const key of restrictedGlobals) {
    defineWorkflowAwareGlobal(global, key, () => undefined);
  }

  globalsPatched = true;
}

export function runWithWorkflowEnvironment<T>(
  getGenerationState: () => GenerationState,
  workflowId: string,
  run: () => T,
): T {
  setupEnvironment();
  if (workflowEnvironmentStorage === undefined) {
    throw new Error("AsyncLocalStorage is not initialized");
  }
  return workflowEnvironmentStorage.run(
    createWorkflowEnvironment(getGenerationState, workflowId),
    run,
  );
}

function noop() {}

// exported for testing
export function createConsole(
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
        case "groupEnd":
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
      }
      return target[prop as keyof Console];
    },
  });
}
