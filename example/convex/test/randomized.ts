import { WorkflowManager } from "@convex-dev/workflow";
import { v } from "convex/values";
import { components, internal } from "../_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server.js";

const workflow = new WorkflowManager(components.workflow);

const operationKind = v.union(
  v.literal("query"),
  v.literal("mutation"),
  v.literal("action"),
  v.literal("sleep"),
);

const faultKind = v.union(
  v.literal("ok"),
  v.literal("error"),
  v.literal("timeout"),
);

const operation = v.object({
  id: v.string(),
  round: v.number(),
  kind: operationKind,
  fault: faultKind,
  failAttempts: v.number(),
  maxAttempts: v.number(),
  scheduled: v.boolean(),
  handoff: v.boolean(),
  value: v.string(),
});

const outcome = v.object({
  operationId: v.string(),
  kind: operationKind,
  status: v.union(v.literal("success"), v.literal("failed")),
  value: v.string(),
});

type Operation = {
  id: string;
  round: number;
  kind: "query" | "mutation" | "action" | "sleep";
  fault: "ok" | "error" | "timeout";
  failAttempts: number;
  maxAttempts: number;
  scheduled: boolean;
  handoff: boolean;
  value: string;
};

type Outcome = {
  operationId: string;
  kind: Operation["kind"];
  status: "success" | "failed";
  value: string;
};

/**
 * A fixed workflow interpreter for deterministic, generated fault plans.
 * Operations sharing a round start together, exercising batch ordering and
 * parallel completion; rounds themselves remain continuation barriers.
 */
export const runFaultPlan = workflow
  .define({
    args: {
      runId: v.string(),
      operations: v.array(operation),
    },
    returns: v.array(outcome),
  })
  .handler(async (step, args): Promise<Outcome[]> => {
    const outcomes: Outcome[] = [];
    const rounds = [...new Set(args.operations.map((item) => item.round))].sort(
      (a, b) => a - b,
    );

    for (const round of rounds) {
      const operations = args.operations.filter((item) => item.round === round);
      outcomes.push(
        ...(await Promise.all(
          operations.map(async (item): Promise<Outcome> => {
            try {
              let value: string;
              const scheduling = item.scheduled ? { runAfter: 1 } : {};
              switch (item.kind) {
                case "query":
                  value = await step.runQuery(
                    internal.test.randomized.probeQuery,
                    item,
                    { name: item.id, ...scheduling },
                  );
                  break;
                case "mutation":
                  value = await step.runMutation(
                    internal.test.randomized.probeMutation,
                    { runId: args.runId, ...item },
                    { name: item.id, ...scheduling },
                  );
                  break;
                case "action":
                  value = await step.runAction(
                    internal.test.randomized.probeAction,
                    { runId: args.runId, ...item },
                    {
                      name: item.id,
                      retry: {
                        maxAttempts: item.maxAttempts,
                        initialBackoffMs: 1,
                        base: 2,
                      },
                      ...(item.handoff ? { timeRequired: 60_000 } : {}),
                      ...scheduling,
                    },
                  );
                  break;
                case "sleep":
                  await step.sleep(item.scheduled ? 1 : 0, { name: item.id });
                  value = item.value;
                  break;
              }
              return {
                operationId: item.id,
                kind: item.kind,
                status: "success",
                value,
              };
            } catch (error) {
              return {
                operationId: item.id,
                kind: item.kind,
                status: "failed",
                value: classifyInjectedFailure(error),
              };
            }
          }),
        )),
      );
    }
    return outcomes;
  });

export const probeQuery = internalQuery({
  args: operation.fields,
  returns: v.string(),
  handler: async (_ctx, args) => {
    injectFailure(args.fault, args.id);
    return args.value;
  },
});

export const probeMutation = internalMutation({
  args: {
    runId: v.string(),
    ...operation.fields,
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("workflowHarnessCommits")
      .withIndex("by_runId_and_operationId", (q) =>
        q.eq("runId", args.runId).eq("operationId", args.id),
      )
      .unique();
    if (existing) {
      throw new Error(`Duplicate mutation commit: ${args.runId}/${args.id}`);
    }
    await ctx.db.insert("workflowHarnessCommits", {
      runId: args.runId,
      operationId: args.id,
      kind: "mutation",
      value: args.value,
    });
    // A failure after the write proves that the nested mutation sub-transaction
    // is rolled back while the workflow driver can still journal the failure.
    injectFailure(args.fault, args.id);
    return args.value;
  },
});

export const probeAction = internalAction({
  args: {
    runId: v.string(),
    ...operation.fields,
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const attempt: number = await ctx.runMutation(
      internal.test.randomized.claimActionAttempt,
      { runId: args.runId, operationId: args.id },
    );
    if (attempt <= args.failAttempts) {
      injectFailure(args.fault, args.id);
    }
    await ctx.runMutation(internal.test.randomized.commitAction, {
      runId: args.runId,
      operationId: args.id,
      value: args.value,
    });
    return args.value;
  },
});

export const claimActionAttempt = internalMutation({
  args: { runId: v.string(), operationId: v.string() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("workflowHarnessActionAttempts")
      .withIndex("by_runId_and_operationId", (q) =>
        q.eq("runId", args.runId).eq("operationId", args.operationId),
      )
      .unique();
    const attempts = (existing?.attempts ?? 0) + 1;
    if (existing) {
      await ctx.db.patch("workflowHarnessActionAttempts", existing._id, {
        attempts,
      });
    } else {
      await ctx.db.insert("workflowHarnessActionAttempts", {
        ...args,
        attempts,
      });
    }
    return attempts;
  },
});

export const commitAction = internalMutation({
  args: { runId: v.string(), operationId: v.string(), value: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("workflowHarnessCommits")
      .withIndex("by_runId_and_operationId", (q) =>
        q.eq("runId", args.runId).eq("operationId", args.operationId),
      )
      .unique();
    if (existing) {
      throw new Error(
        `Duplicate action commit: ${args.runId}/${args.operationId}`,
      );
    }
    await ctx.db.insert("workflowHarnessCommits", {
      ...args,
      kind: "action",
    });
    return null;
  },
});

export const readRunState = internalQuery({
  args: { runId: v.string() },
  returns: v.object({
    commits: v.array(
      v.object({
        operationId: v.string(),
        kind: v.union(v.literal("mutation"), v.literal("action")),
        value: v.string(),
      }),
    ),
    actionAttempts: v.array(
      v.object({ operationId: v.string(), attempts: v.number() }),
    ),
  }),
  handler: async (ctx, args) => {
    const commits = await ctx.db
      .query("workflowHarnessCommits")
      .withIndex("by_runId_and_operationId", (q) => q.eq("runId", args.runId))
      .take(256);
    const actionAttempts = await ctx.db
      .query("workflowHarnessActionAttempts")
      .withIndex("by_runId_and_operationId", (q) => q.eq("runId", args.runId))
      .take(256);
    return {
      commits: commits.map(({ operationId, kind, value }) => ({
        operationId,
        kind,
        value,
      })),
      actionAttempts: actionAttempts.map(({ operationId, attempts }) => ({
        operationId,
        attempts,
      })),
    };
  },
});

function injectFailure(fault: Operation["fault"], operationId: string): void {
  if (fault === "ok") return;
  const marker =
    fault === "timeout" ? "INJECTED_SYSTEM_TIMEOUT" : "INJECTED_ERROR";
  throw new Error(`${marker}:${operationId}`);
}

function classifyInjectedFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("INJECTED_SYSTEM_TIMEOUT")) return "timeout";
  if (message.includes("INJECTED_ERROR")) return "error";
  return `unexpected:${message}`;
}
