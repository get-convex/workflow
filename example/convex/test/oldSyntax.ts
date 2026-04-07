/**
 * Old-syntax test using WorkflowManager + workflow.define.
 * Exercises: define, start, status, cancel, cleanup, sendEvent, createEvent,
 * and step methods: runQuery, runMutation, runAction, sleep, awaitEvent.
 */
import { v } from "convex/values";
import { WorkflowManager } from "@convex-dev/workflow";
import { internal } from "../_generated/api.js";
import { components } from "../_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server.js";

const workflow = new WorkflowManager(components.workflow);

// -- Workflow definition using old syntax --

export const oldSyntaxWorkflow = workflow.define({
  args: { value: v.number() },
  returns: v.object({
    queried: v.number(),
    mutated: v.number(),
    acted: v.string(),
    eventValue: v.string(),
  }),
  handler: async (
    step,
    args,
  ): Promise<{
    queried: number;
    mutated: number;
    acted: string;
    eventValue: string;
  }> => {
    // step.runQuery
    const queried = await step.runQuery(internal.test.oldSyntax.doubleQuery, {
      n: args.value,
    });
    // step.runMutation
    const mutated = await step.runMutation(
      internal.test.oldSyntax.incrementMutation,
      { n: queried },
    );
    // step.runAction (parallel with sleep)
    const [acted] = await Promise.all([
      step.runAction(internal.test.oldSyntax.echoAction, {
        msg: `val=${mutated}`,
      }),
      // step.sleep
      step.sleep(10, { name: "brief-pause" }),
    ]);
    // step.awaitEvent
    const eventValue = await step.awaitEvent<string>({
      name: "approval",
      validator: v.string(),
    });
    return { queried, mutated, acted, eventValue };
  },
});

// -- Helper functions --

export const doubleQuery = internalQuery({
  args: { n: v.number() },
  returns: v.number(),
  handler: async (_ctx, { n }) => n * 2,
});

export const incrementMutation = internalMutation({
  args: { n: v.number() },
  returns: v.number(),
  handler: async (_ctx, { n }) => n + 1,
});

export const echoAction = internalAction({
  args: { msg: v.string() },
  returns: v.string(),
  handler: async (_ctx, { msg }) => `echo:${msg}`,
});

// -- E2E: start workflow, send event, poll for completion --

export default internalAction({
  args: {},
  returns: v.object({
    queried: v.number(),
    mutated: v.number(),
    acted: v.string(),
    eventValue: v.string(),
  }),
  handler: async (ctx) => {
    // workflow.start
    const workflowId = await workflow.start(
      ctx,
      internal.test.oldSyntax.oldSyntaxWorkflow,
      { value: 5 },
    );

    // workflow.status — poll until the workflow is waiting for the event
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = await workflow.status(ctx, workflowId);
      if (s.type !== "inProgress") throw new Error(`Unexpected: ${s.type}`);
      if (s.running.some((r) => "kind" in r && r.kind === "event")) break;
    }

    // workflow.sendEvent
    await workflow.sendEvent(ctx, {
      workflowId,
      name: "approval",
      value: "approved!",
    });

    // Poll until completed
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const s = await workflow.status(ctx, workflowId);
      if (s.type === "completed") {
        // workflow.cleanup
        await workflow.cleanup(ctx, workflowId);
        return s.result as {
          queried: number;
          mutated: number;
          acted: string;
          eventValue: string;
        };
      }
      if (s.type === "failed") throw new Error(s.error);
    }
    throw new Error("Workflow did not complete in time");
  },
});
