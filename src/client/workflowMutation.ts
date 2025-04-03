import { api } from "../component/_generated/api.js";
import { PropertyValidators, v } from "convex/values";
import { Result, UseApi } from "../types.js";
import { WorkflowDefinition } from "./index.js";
import { internalMutationGeneric, RegisteredMutation } from "convex/server";
import { BaseChannel } from "async-channel";
import { StepExecutor, StepRequest, WorkerResult } from "./step.js";
import { StepContext } from "./stepContext.js";
import { setupEnvironment } from "./environment.js";
import { JournalEntry } from "../component/schema.js";
import { checkArgs } from "./validator.js";
import { validate } from "convex-helpers/validators";
import { assert } from "convex-helpers";

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
): RegisteredMutation<"internal", never, never> {
  return internalMutationGeneric({
    returns: v.null(),
    handler: async (ctx, args) => {
      if (!validate(workflowArgs, args)) {
        throw new Error(INVALID_WORKFLOW_MESSAGE);
      }
      const { workflowId, generationNumber } = args;
      const { workflow, inProgress } = await ctx.runQuery(
        component.workflow.getStatus,
        { workflowId },
      );
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
      const journalEntries = (await ctx.runQuery(component.journal.load, {
        workflowId,
      })) as JournalEntry[];
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
        journalEntries,
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
              await ctx.runMutation(component.functions.start, {
                name: result.name,
                workflowId,
                generationNumber,
                journalId: _id,
                functionType: step.functionType,
                handle: step.handle,
                args: step.args,
                // TODO: retryBehavior: {},
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
