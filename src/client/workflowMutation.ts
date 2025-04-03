import { WorkId, Workpool } from "@convex-dev/workpool";
import { BaseChannel } from "async-channel";
import { assert } from "convex-helpers";
import { validate } from "convex-helpers/validators";
import {
  FunctionHandle,
  internalMutationGeneric,
  RegisteredMutation,
} from "convex/server";
import { ObjectType, PropertyValidators, v } from "convex/values";
import { api } from "../component/_generated/api.js";
import { createLogger } from "../component/logging.js";
import type { OnComplete, OnCompleteContext } from "../component/pool.js";
import { JournalEntry } from "../component/schema.js";
import { OpaqueIds, Result, UseApi } from "../types.js";
import { setupEnvironment } from "./environment.js";
import { WorkflowDefinition } from "./index.js";
import { StepExecutor, StepRequest, WorkerResult } from "./step.js";
import { StepContext } from "./stepContext.js";
import { checkArgs } from "./validator.js";

const workflowArgs = v.object({
  workflowId: v.id("workflows"),
  generationNumber: v.number(),
});
const INVALID_WORKFLOW_MESSAGE = `Invalid arguments for workflow: Did you invoke the workflow with ctx.runMutation() instead of workflow.start()?`;

// This function is defined in the calling component but then gets passed by
// function handle to the workflow component for execution. This function runs
// one "poll" of the workflow, replaying its execution from the journal until
// it blocks next.
export function workflowMutation<ArgsValidator extends PropertyValidators>(
  component: UseApi<typeof api>,
  registered: WorkflowDefinition<ArgsValidator>,
  workpool: Workpool,
): RegisteredMutation<"internal", ObjectType<ArgsValidator>, null> {
  const onComplete = component.pool.onComplete as OnComplete;
  return internalMutationGeneric({
    returns: v.null(),
    handler: async (ctx, args) => {
      if (!validate(workflowArgs, args)) {
        throw new Error(INVALID_WORKFLOW_MESSAGE);
      }
      const { workflowId, generationNumber } = args;
      const { workflow, inProgress, logLevel, journalEntries, ok } =
        await ctx.runQuery(component.journal.load, { workflowId });
      const console = createLogger(logLevel);
      if (!ok) {
        console.error(`Failed to load journal for ${workflowId}`);
        await ctx.runMutation(component.workflow.complete, {
          workflowId,
          generationNumber,
          outcome: { type: "error", error: "Failed to load journal" },
          now: Date.now(),
        });
        return;
      }
      if (workflow.generationNumber !== generationNumber) {
        console.error(`Invalid generation number: ${generationNumber}`);
        return;
      }
      if (workflow.state.type === "completed") {
        console.log(`Workflow ${workflowId} completed, returning.`);
        return;
      }
      if (inProgress.length > 0) {
        console.log(
          `Workflow ${workflowId} blocked by ` +
            inProgress
              .map((entry) => `${entry._id}: ${entry.step.type}`)
              .join(", "),
        );
        return;
      }
      for (const journalEntry of journalEntries) {
        assert(
          !journalEntry.step.inProgress,
          `Assertion failed: not blocked but have in-progress journal entry`,
        );
      }
      const channel = new BaseChannel<StepRequest>(0);
      const step = new StepContext(channel);
      const originalEnv = setupEnvironment(step);
      const executor = new StepExecutor(
        workflowId,
        generationNumber,
        ctx,
        component,
        journalEntries as JournalEntry[],
        channel,
        originalEnv,
      );

      const handlerWorker = async (): Promise<WorkerResult> => {
        let outcome: Result<null>;
        try {
          checkArgs(workflow.args, registered.args);
          await registered.handler(step, workflow.args);
          outcome = { type: "success", result: null, resultSize: 0 };
        } catch (error) {
          outcome = { type: "error", error: (error as Error).message };
        }
        return { type: "handlerDone", outcome };
      };
      const executorWorker = async (): Promise<WorkerResult> => {
        return await executor.run();
      };
      const result = await Promise.race([handlerWorker(), executorWorker()]);
      switch (result.type) {
        case "handlerDone": {
          await ctx.runMutation(component.workflow.complete, {
            workflowId,
            generationNumber,
            outcome: result.outcome,
            now: originalEnv.Date.now(),
          });
          break;
        }
        case "executorBlocked": {
          const { _id, step } = result.entry;
          switch (step.type) {
            case "function": {
              const retry =
                result.retry === true
                  ? registered.defaultRetryBehavior ?? true
                  : result.retry ??
                    (registered.retryActionsByDefault
                      ? registered.defaultRetryBehavior
                      : undefined);
              await ctx.runMutation(component.functions.start, {
                name: result.name,
                workflowId,
                generationNumber,
                journalId: _id,
                functionType: step.functionType,
                handle: step.handle,
                args: step.args,
                retry,
              });
              break;
            }
            case "sleep": {
              await ctx.runMutation(component.sleep.start, {
                workflowId,
                generationNumber,
                journalId: _id,
                durationMs: step.durationMs,
              });
              break;
            }
          }
        }
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE getDefaultLogger";
