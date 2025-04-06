import { BaseChannel } from "async-channel";
import { assert } from "convex-helpers";
import { validate } from "convex-helpers/validators";
import { internalMutationGeneric, RegisteredMutation } from "convex/server";
import {
  asObjectValidator,
  ObjectType,
  PropertyValidators,
  v,
} from "convex/values";
import { api } from "../component/_generated/api.js";
import { createLogger } from "../component/logging.js";
import { JournalEntry } from "../component/schema.js";
import { UseApi } from "../types.js";
import { setupEnvironment } from "./environment.js";
import { WorkflowDefinition } from "./index.js";
import { StepExecutor, StepRequest, WorkerResult } from "./step.js";
import { StepContext } from "./stepContext.js";
import { checkArgs } from "./validator.js";
import { RunResult, WorkpoolOptions } from "@convex-dev/workpool";

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
  registered: WorkflowDefinition<ArgsValidator, any, any>,
  defaultWorkpoolOptions?: WorkpoolOptions,
): RegisteredMutation<"internal", ObjectType<ArgsValidator>, void> {
  const workpoolOptions = {
    ...defaultWorkpoolOptions,
    ...registered.workpoolOptions,
  };
  return internalMutationGeneric({
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
          runResult: { kind: "failed", error: "Failed to load journal" },
          now: Date.now(),
        });
        return;
      }
      if (workflow.generationNumber !== generationNumber) {
        console.error(`Invalid generation number: ${generationNumber}`);
        return;
      }
      if (workflow.runResult?.kind === "success") {
        console.log(`Workflow ${workflowId} completed, returning.`);
        return;
      }
      if (inProgress.length > 0) {
        console.log(
          `Workflow ${workflowId} blocked by ` +
            inProgress
              .map((entry) => `${entry.step.name} (${entry._id})`)
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
      const channel = new BaseChannel<StepRequest>(
        workpoolOptions.maxParallelism ?? 10,
      );
      const step = new StepContext(workflowId, channel);
      const originalEnv = setupEnvironment(step);
      const executor = new StepExecutor(
        workflowId,
        generationNumber,
        ctx,
        component,
        journalEntries as JournalEntry[],
        channel,
        originalEnv,
        workpoolOptions,
      );

      const handlerWorker = async (): Promise<WorkerResult> => {
        let runResult: RunResult;
        try {
          checkArgs(workflow.args, registered.args);
          const returnValue =
            (await registered.handler(step, workflow.args)) ?? null;
          runResult = { kind: "success", returnValue };
          if (registered.returns) {
            try {
              validate(asObjectValidator(registered.returns), returnValue, {
                throw: true,
              });
            } catch (error) {
              const message =
                error instanceof Error ? error.message : `${error}`;
              runResult = {
                kind: "failed",
                error: "Invalid return value: " + message,
              };
            }
          }
        } catch (error) {
          runResult = { kind: "failed", error: (error as Error).message };
        }
        return { type: "handlerDone", runResult };
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
            runResult: result.runResult,
            now: originalEnv.Date.now(),
          });
          break;
        }
        case "executorBlocked": {
          // Nothing to do, we already started steps in the StepExecutor.
          break;
        }
      }
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE getDefaultLogger";
