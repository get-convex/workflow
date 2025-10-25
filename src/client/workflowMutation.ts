import { BaseChannel } from "async-channel";
import { assert } from "convex-helpers";
import { validate, ValidationError } from "convex-helpers/validators";
import {
  createFunctionHandle,
  internalMutationGeneric,
  makeFunctionReference,
  type RegisteredMutation,
} from "convex/server";
import {
  asObjectValidator,
  type ObjectType,
  type PropertyValidators,
  v,
} from "convex/values";
import { createLogger } from "../component/logging.js";
import { type JournalEntry } from "../component/schema.js";
import { setupEnvironment } from "./environment.js";
import type { WorkflowDefinition } from "./index.js";
import { StepExecutor, type StepRequest, type WorkerResult } from "./step.js";
import { createWorkflowCtx } from "./workflowContext.js";
import { checkArgs } from "./validator.js";
import { type RunResult, type WorkpoolOptions } from "@convex-dev/workpool";
import { type WorkflowComponent } from "./types.js";
import { vWorkflowId } from "../types.js";
import { formatErrorWithStack } from "../shared.js";
import { safeFunctionName } from "./safeFunctionName.js";

const workflowArgs = v.union(
  v.object({
    workflowId: vWorkflowId,
    generationNumber: v.number(),
  }),
  v.object({
    fn: v.string(),
    args: v.any(),
  }),
);
const INVALID_WORKFLOW_MESSAGE = `Invalid arguments for workflow: Did you invoke the workflow with ctx.runMutation() instead of workflow.start()? Pro tip: to start a workflow directly from the CLI or dashboard, you can use args '{ fn: "path/to/file:workflowName", args: { ...your workflow args } }'`;

// This function is defined in the calling component but then gets passed by
// function handle to the workflow component for execution. This function runs
// one "poll" of the workflow, replaying its execution from the journal until
// it blocks next.
export function workflowMutation<ArgsValidator extends PropertyValidators>(
  component: WorkflowComponent,
  registered: WorkflowDefinition<ArgsValidator>,
  defaultWorkpoolOptions?: WorkpoolOptions,
): RegisteredMutation<
  "internal",
  {
    fn: "You should not call this directly, call workflow.start instead";
    args: ObjectType<ArgsValidator>;
  },
  void
> {
  const workpoolOptions = {
    ...defaultWorkpoolOptions,
    ...registered.workpoolOptions,
  };
  return internalMutationGeneric({
    handler: async (ctx, args) => {
      if (!validate(workflowArgs, args)) {
        throw new Error(INVALID_WORKFLOW_MESSAGE);
      }
      if ("fn" in args) {
        const fn = makeFunctionReference(args.fn);
        const workflowId = await ctx.runMutation(component.workflow.create, {
          workflowName: safeFunctionName(fn),
          workflowHandle: await createFunctionHandle(fn),
          workflowArgs: args.args,
          maxParallelism: workpoolOptions.maxParallelism,
        });
        return workflowId;
      }
      const { workflowId, generationNumber } = args;
      const { workflow, logLevel, journalEntries, ok } = await ctx.runQuery(
        component.journal.load,
        { workflowId, shortCircuit: true },
      );
      const inProgress = journalEntries.filter(({ step }) => step.inProgress);
      const console = createLogger(logLevel);
      if (!ok) {
        console.error(`Failed to load journal for ${workflowId}`);
        await ctx.runMutation(component.workflow.complete, {
          workflowId,
          generationNumber,
          runResult: { kind: "failed", error: "Failed to load journal" },
        });
        return;
      }
      if (workflow.generationNumber !== generationNumber) {
        console.error(
          `Invalid generation number: ${generationNumber} running workflow ${workflow.name} (${workflowId})`,
        );
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
      const step = createWorkflowCtx(workflowId, channel);
      const executor = new StepExecutor(
        workflowId,
        generationNumber,
        ctx,
        component,
        journalEntries as JournalEntry[],
        channel,
        Date.now(),
        workpoolOptions,
      );
      setupEnvironment(executor.getGenerationState.bind(executor), workflowId);

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
                error instanceof ValidationError
                  ? error.message
                  : formatErrorWithStack(error);
              console.error(
                "Workflow handler returned invalid return value: ",
                message,
              );
              runResult = {
                kind: "failed",
                error: "Invalid return value: " + message,
              };
            }
          }
        } catch (error) {
          const message = formatErrorWithStack(error);
          console.error(message);
          runResult = { kind: "failed", error: message };
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
          });
          break;
        }
        case "executorBlocked": {
          // Nothing to do, we already started steps in the StepExecutor.
          break;
        }
      }
    },
  }) as any;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE getDefaultLogger";
