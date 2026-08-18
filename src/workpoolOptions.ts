import { vRetryBehavior, type WorkpoolOptions } from "@convex-dev/workpool";
import { type Infer, v } from "convex/values";
import { logLevel } from "./logging.js";

export const workpoolOptions = v.object({
  logLevel: v.optional(logLevel),
  maxParallelism: v.optional(v.number()),
  defaultRetryBehavior: v.optional(vRetryBehavior),
  retryActionsByDefault: v.optional(v.boolean()),
});

const _workpoolOptions: WorkpoolOptions = {} as Infer<typeof workpoolOptions>;
void _workpoolOptions;
