import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import {
  journalDocument,
  JournalEntry,
  journalEntrySize,
  step,
  workflowDocument,
} from "./schema.js";
import { getWorkflow } from "./model.js";
import { logLevel } from "./logging.js";
import { vRetryBehavior, WorkId } from "@convex-dev/workpool";
import { getStatusHandler } from "./workflow.js";
import { getWorkpool, OnCompleteContext, workpoolOptions } from "./pool.js";
import { internal } from "./_generated/api.js";
import { FunctionHandle } from "convex/server";
import { getDefaultLogger } from "./utils.js";
import { assert } from "convex-helpers";

export const load = query({
  args: {
    workflowId: v.id("workflows"),
  },
  returns: v.object({
    workflow: workflowDocument,
    inProgress: v.array(journalDocument),
    journalEntries: v.array(journalDocument),
    ok: v.boolean(),
    logLevel,
  }),
  handler: async (ctx, { workflowId }) => {
    const { workflow, inProgress, logLevel } = await getStatusHandler(ctx, {
      workflowId,
    });
    const journalEntries: JournalEntry[] = [];
    let sizeSoFar = 0;
    for await (const entry of ctx.db
      .query("steps")
      .withIndex("workflow", (q) => q.eq("workflowId", workflowId))) {
      journalEntries.push(entry);
      sizeSoFar += journalEntrySize(entry);
      if (sizeSoFar > 4 * 1024 * 1024) {
        return { journalEntries, ok: false, workflow, inProgress, logLevel };
      }
    }
    return { journalEntries, ok: true, workflow, inProgress, logLevel };
  },
});

// TODO: have it also start the step
export const startStep = mutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    name: v.string(),
    step,
    workpoolOptions: v.optional(workpoolOptions),
    retry: v.optional(v.union(v.boolean(), vRetryBehavior)),
    schedulerOptions: v.optional(
      v.union(
        v.object({ runAt: v.optional(v.number()) }),
        v.object({ runAfter: v.optional(v.number()) }),
      ),
    ),
  },
  returns: journalDocument,
  handler: async (ctx, args): Promise<JournalEntry> => {
    if (!args.step.inProgress) {
      throw new Error(`Assertion failed: not in progress`);
    }
    const workflow = await getWorkflow(
      ctx,
      args.workflowId,
      args.generationNumber,
    );
    const console = await getDefaultLogger(ctx);

    if (workflow.runResult !== undefined) {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    const maxEntry = await ctx.db
      .query("steps")
      .withIndex("workflow", (q) => q.eq("workflowId", workflow._id))
      .order("desc")
      .first();
    const stepNumber = maxEntry ? maxEntry.stepNumber + 1 : 0;
    const { name, step, generationNumber, retry } = args;
    const stepId = await ctx.db.insert("steps", {
      workflowId: workflow._id,
      stepNumber,
      step,
    });
    const entry = await ctx.db.get(stepId);
    assert(entry, "Step not found");
    const workpool = await getWorkpool(ctx, args.workpoolOptions);
    const onComplete = internal.pool.onComplete;
    const context: OnCompleteContext = {
      generationNumber,
      stepId,
    };
    let workId: WorkId;
    switch (step.functionType) {
      case "query": {
        workId = await workpool.enqueueQuery(
          ctx,
          step.handle as FunctionHandle<"query">,
          step.args,
          { context, onComplete, name, ...args.schedulerOptions },
        );
        break;
      }
      case "mutation": {
        workId = await workpool.enqueueMutation(
          ctx,
          step.handle as FunctionHandle<"mutation">,
          step.args,
          { context, onComplete, name, ...args.schedulerOptions },
        );
        break;
      }
      case "action": {
        workId = await workpool.enqueueAction(
          ctx,
          step.handle as FunctionHandle<"action">,
          step.args,
          { context, onComplete, name, retry, ...args.schedulerOptions },
        );
        break;
      }
    }
    entry.step.workId = workId;
    await ctx.db.replace(entry._id, entry);

    console.event("started", {
      workflowId: workflow._id,
      workflowName: workflow.name,
      stepName: step.name,
      stepNumber,
    });
    return entry;
  },
});
