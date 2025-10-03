import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import {
  journalDocument,
  type JournalEntry,
  journalEntrySize,
  step,
  workflowDocument,
} from "./schema.js";
import { getWorkflow } from "./model.js";
import { logLevel } from "./logging.js";
import { vRetryBehavior, type WorkId } from "@convex-dev/workpool";
import {
  getWorkpool,
  type OnCompleteContext,
  workpoolOptions,
} from "./pool.js";
import { internal } from "./_generated/api.js";
import { type FunctionHandle } from "convex/server";
import { getDefaultLogger } from "./utils.js";
import { assert } from "convex-helpers";

export const load = query({
  args: {
    workflowId: v.id("workflows"),
  },
  returns: v.object({
    workflow: workflowDocument,
    journalEntries: v.array(journalDocument),
    ok: v.boolean(),
    logLevel,
  }),
  handler: async (ctx, { workflowId }) => {
    const workflow = await ctx.db.get(workflowId);
    assert(workflow, `Workflow not found: ${workflowId}`);
    const { logLevel } = await getDefaultLogger(ctx);
    const journalEntries: JournalEntry[] = [];
    let sizeSoFar = 0;
    for await (const entry of ctx.db
      .query("steps")
      .withIndex("workflow", (q) => q.eq("workflowId", workflowId))) {
      journalEntries.push(entry);
      sizeSoFar += journalEntrySize(entry);
      if (sizeSoFar > 4 * 1024 * 1024) {
        return { journalEntries, ok: false, workflow, logLevel };
      }
    }
    return { journalEntries, ok: true, workflow, logLevel };
  },
});

export const startSteps = mutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    steps: v.array(
      v.object({
        step,
        retry: v.optional(v.union(v.boolean(), vRetryBehavior)),
        schedulerOptions: v.optional(
          v.union(
            v.object({ runAt: v.optional(v.number()) }),
            v.object({ runAfter: v.optional(v.number()) }),
          ),
        ),
      }),
    ),
    workpoolOptions: v.optional(workpoolOptions),
  },
  returns: v.array(journalDocument),
  handler: async (ctx, args): Promise<JournalEntry[]> => {
    if (!args.steps.every((step) => step.step.inProgress)) {
      throw new Error(`Assertion failed: not in progress`);
    }
    const { generationNumber } = args;
    const workflow = await getWorkflow(ctx, args.workflowId, generationNumber);
    const console = await getDefaultLogger(ctx);

    if (workflow.runResult !== undefined) {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    const maxEntry = await ctx.db
      .query("steps")
      .withIndex("workflow", (q) => q.eq("workflowId", workflow._id))
      .order("desc")
      .first();
    const stepNumberBase = maxEntry ? maxEntry.stepNumber + 1 : 0;
    const workpool = await getWorkpool(ctx, args.workpoolOptions);
    const onComplete = internal.pool.onComplete;

    const entries = await Promise.all(
      args.steps.map(async (stepArgs, index) => {
        const { step, retry, schedulerOptions } = stepArgs;
        const stepNumber = stepNumberBase + index;
        const stepId = await ctx.db.insert("steps", {
          workflowId: workflow._id,
          stepNumber,
          step,
        });
        const entry = await ctx.db.get(stepId);
        assert(entry, "Step not found");
        const context: OnCompleteContext = {
          generationNumber,
          stepId,
        };
        let workId: WorkId | undefined = undefined;
        
        if (step.type === "execution") {
          switch (step.functionType) {
            case "query": {
              workId = await workpool.enqueueQuery(
                ctx,
                step.handle as FunctionHandle<"query">,
                step.args,
                { context, onComplete, name: step.name, ...schedulerOptions },
              );
              break;
            }
            case "mutation": {
              workId = await workpool.enqueueMutation(
                ctx,
                step.handle as FunctionHandle<"mutation">,
                step.args,
                { context, onComplete, name: step.name, ...schedulerOptions },
              );
              break;
            }
            case "action": {
              workId = await workpool.enqueueAction(
                ctx,
                step.handle as FunctionHandle<"action">,
                step.args,
                { context, onComplete, name: step.name, retry, ...schedulerOptions },
              );
              break;
            }
          }
        } else if (step.type === "pause") {
          if (step.onPauseHandle) {
            workId = await workpool.enqueueMutation(
              ctx,
              step.onPauseHandle as FunctionHandle<"mutation">,
              step.args,
              { context, onComplete, name: step.name, ...schedulerOptions },
            );
          }
        }
        
        if (workId) {
          entry.step.workId = workId;
          await ctx.db.replace(entry._id, entry);
        }

        console.event("started", {
          workflowId: workflow._id,
          workflowName: workflow.name,
          stepName: step.name,
          stepNumber,
        });
        return entry;
      }),
    );
    return entries;
  },
});

export const resume = mutation({
  args: {
    workflowHandle: v.string(),
    workflowId: v.id("workflows"),
    resumeValue: v.any(),
    name: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const console = await getDefaultLogger(ctx);
    const workflow = await getWorkflow(ctx, args.workflowId, null);

    if (workflow.runResult) {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }

    if (workflow.workflowHandle !== args.workflowHandle) {
      throw new Error(
        `Workflow handle mismatch: expected ${workflow.workflowHandle}, got ${args.workflowHandle}`,
      );
    }

    let query = ctx.db
      .query("steps")
      .withIndex("inProgress", (q) =>
        q.eq("step.inProgress", true).eq("workflowId", args.workflowId),
      )
      .filter((q) => q.eq(q.field("step.type"), "pause"));

    if (args.name) {
      query = query.filter((q) => q.eq(q.field("step.name"), args.name));
    }

    const pausedStep = await query.first();

    if (!pausedStep) {
      const message = args.name
        ? `No paused step with name "${args.name}" found for workflow: ${args.workflowId}`
        : `No paused step found for workflow: ${args.workflowId}`;
      throw new Error(message);
    }

    pausedStep.step.inProgress = false;
    pausedStep.step.completedAt = Date.now();
    pausedStep.step.runResult = {
      kind: "success",
      returnValue: args.resumeValue,
    };

    await ctx.db.replace(pausedStep._id, pausedStep);

    console.event("stepResumed", {
      workflowId: workflow._id,
      workflowName: workflow.name,
      stepName: pausedStep.step.name,
      stepNumber: pausedStep.stepNumber,
    });

    const workpool = await getWorkpool(ctx, {});
    await workpool.enqueueMutation(
      ctx,
      workflow.workflowHandle as FunctionHandle<"mutation">,
      {
        workflowId: workflow._id,
        generationNumber: workflow.generationNumber,
      },
      {
        name: workflow.name,
        onComplete: internal.pool.handlerOnComplete,
        context: {
          workflowId: workflow._id,
          generationNumber: workflow.generationNumber,
        },
      },
    );
  },
});
