import { v } from "convex/values";
import { internalMutation, QueryCtx } from "./_generated/server.js";
import { createLogger, DEFAULT_LOG_LEVEL, logLevel } from "./logging.js";

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
