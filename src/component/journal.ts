import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import {
  journalDocument,
  JournalEntry,
  step,
  workflowDocument,
} from "./schema.js";
import { getWorkflow } from "./model.js";
import { createLogger, logLevel } from "./logging.js";
import { vWorkIdValidator } from "@convex-dev/workpool";
import { assert } from "convex-helpers";
import { getStatusHandler } from "./workflow.js";

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
      .query("workflowJournal")
      .withIndex("workflow", (q) => q.eq("workflowId", workflowId))) {
      journalEntries.push(entry);
      if (entry.step.type === "function") {
        sizeSoFar += entry.step.argsSize;
        if (entry.step.outcome?.type === "success") {
          sizeSoFar += entry.step.outcome.resultSize;
        }
      }
      if (sizeSoFar > 4 * 1024 * 1024) {
        return { journalEntries, ok: false, workflow, inProgress, logLevel };
      }
    }
    return { journalEntries, ok: true, workflow, inProgress, logLevel };
  },
});

export const pushEntry = mutation({
  args: {
    workflowId: v.string(),
    generationNumber: v.number(),
    stepNumber: v.number(),
    step,
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
    const logger = createLogger(workflow.logLevel);

    if (workflow.state.type != "running") {
      throw new Error(`Workflow not running: ${args.workflowId}`);
    }
    const existing = await ctx.db
      .query("workflowJournal")
      .withIndex("workflow", (q) =>
        q.eq("workflowId", workflow._id).eq("stepNumber", args.stepNumber),
      )
      .first();
    if (existing) {
      throw new Error(`Journal entry already exists: ${args.workflowId}`);
    }
    const maxEntry = await ctx.db
      .query("workflowJournal")
      .withIndex("workflow", (q) => q.eq("workflowId", workflow._id))
      .order("desc")
      .first();
    if (maxEntry && maxEntry.stepNumber + 1 !== args.stepNumber) {
      throw new Error(`Invalid step number: ${args.stepNumber}`);
    }
    const journalId = await ctx.db.insert("workflowJournal", {
      workflowId: workflow._id,
      stepNumber: args.stepNumber,
      step: args.step,
    });
    const entry = await ctx.db.get(journalId);
    logger.debug(`Pushed new journal entry`, entry);
    return entry! as JournalEntry;
  },
});

export const updateWorkId = mutation({
  args: {
    journalId: v.id("workflowJournal"),
    workId: vWorkIdValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const journalEntry = await ctx.db.get(args.journalId);
    assert(journalEntry, `Journal entry not found: ${args.journalId}`);
    journalEntry.step.workId = args.workId;
    await ctx.db.replace(args.journalId, journalEntry);
  },
});
