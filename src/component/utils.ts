import { Workpool } from "@convex-dev/workpool";
import { components } from "./_generated/api.js";
import {
  internalMutation,
  MutationCtx,
  QueryCtx,
} from "./_generated/server.js";
import {
  createLogger,
  LogLevel,
  DEFAULT_LOG_LEVEL,
  logLevel,
} from "./logging.js";
import { v } from "convex/values";

export async function createDefaultLogger(
  ctx: MutationCtx,
  newLogLevel: LogLevel | undefined,
) {
  const config = await ctx.db.query("config").first();
  const logLevel = newLogLevel ?? config?.logLevel ?? DEFAULT_LOG_LEVEL;
  if (!config) {
    await ctx.db.insert("config", { logLevel });
  } else if (newLogLevel) {
    await ctx.db.patch(config._id, { logLevel: newLogLevel });
  }
  return createLogger(logLevel);
}

export async function getDefaultLogger(ctx: QueryCtx) {
  const config = await ctx.db.query("config").first();
  return createLogger(config?.logLevel ?? DEFAULT_LOG_LEVEL);
}

// For now, only configure by calling from the dashboard or CLI.
export const updateConfig = internalMutation({
  args: {
    logLevel: v.optional(logLevel),
    maxParallelism: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const config = await ctx.db.query("config").first();
    if (!config) {
      await ctx.db.insert("config", {
        logLevel: args.logLevel ?? DEFAULT_LOG_LEVEL,
        maxParallelism: args.maxParallelism,
      });
    } else {
      if (args.logLevel) {
        await ctx.db.patch(config._id, {
          logLevel: args.logLevel,
        });
      }
      if (args.maxParallelism) {
        await ctx.db.patch(config._id, {
          maxParallelism: args.maxParallelism,
        });
      }
    }
  },
});

export async function getWorkpool(
  ctx: MutationCtx,
  opts?: {
    logLevel?: LogLevel | undefined;
    maxParallelism?: number | undefined;
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
  return new Workpool(components.workpool, { ...config, ...opts });
}
