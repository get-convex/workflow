import { v } from "convex/values";
import {
  internalMutation,
  MutationCtx,
  QueryCtx,
} from "./_generated/server.js";
import {
  createLogger,
  DEFAULT_LOG_LEVEL,
  LogLevel,
  logLevel,
} from "./logging.js";

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
export const setLogLevel = internalMutation({
  args: {
    logLevel: v.optional(logLevel),
  },
  handler: async (ctx, args) => {
    const config = await ctx.db.query("config").first();
    if (!config) {
      await ctx.db.insert("config", {
        logLevel: args.logLevel ?? DEFAULT_LOG_LEVEL,
      });
    } else {
      if (args.logLevel) {
        await ctx.db.patch(config._id, {
          logLevel: args.logLevel,
        });
      }
    }
  },
});
