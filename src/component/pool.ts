import { RetryBehavior, Workpool } from "@convex-dev/workpool";
import { components } from "./_generated/api.js";
import { MutationCtx } from "./_generated/server.js";
import { DEFAULT_LOG_LEVEL, LogLevel, createLogger } from "./logging.js";

export const DEFAULT_MAX_PARALLELISM = 50;
export const DEFAULT_RETRY_BEHAVIOR = {
  maxAttempts: 5,
  initialBackoffMs: 500,
  base: 2,
};

export async function getWorkpool(
  ctx: MutationCtx,
  opts: {
    logLevel?: LogLevel | undefined;
    maxParallelism?: number | undefined;
    defaultRetryBehavior: RetryBehavior | undefined;
    retryActionsByDefault: boolean | undefined;
  },
) {
  const config = await ctx.db.query("config").first();
  const logLevel = opts?.logLevel ?? config?.logLevel ?? DEFAULT_LOG_LEVEL;
  const console = createLogger(logLevel);
  if (config) {
    if (opts?.logLevel && logLevel !== config.logLevel) {
      await ctx.db.patch(config._id, { logLevel });
    }
    if (opts?.maxParallelism && opts.maxParallelism !== config.maxParallelism) {
      console.warn("Updating max parallelism", opts.maxParallelism);
      await ctx.db.patch(config._id, { maxParallelism: opts.maxParallelism });
    }
  } else {
    await ctx.db.insert("config", {
      logLevel,
      maxParallelism: opts?.maxParallelism,
    });
  }
  const maxParallelism =
    opts?.maxParallelism ?? config?.maxParallelism ?? DEFAULT_MAX_PARALLELISM;
  return new Workpool(components.workpool, {
    logLevel,
    maxParallelism,
    defaultRetryBehavior: opts?.defaultRetryBehavior ?? DEFAULT_RETRY_BEHAVIOR,
    retryActionsByDefault: opts?.retryActionsByDefault ?? false,
  });
}
