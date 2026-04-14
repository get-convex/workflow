import { type RunResult, type WorkpoolOptions } from "@convex-dev/workpool";
import { BaseChannel } from "async-channel";
import { assert } from "convex-helpers";
import { validate, ValidationError } from "convex-helpers/validators";
import {
  createFunctionHandle,
  internalMutationGeneric,
  makeFunctionReference,
  type FunctionHandle,
  type RegisteredMutation,
} from "convex/server";
import {
  asObjectValidator,
  v,
  type ObjectType,
  type PropertyValidators,
} from "convex/values";
import { createLogger } from "../component/logging.js";
import { type JournalEntry } from "../component/schema.js";
import { formatErrorWithStack } from "../shared.js";
import { vWorkflowId, type OnCompleteArgs, type WorkflowId } from "../types.js";
import { setupEnvironment } from "./environment.js";
import type { WorkflowDefinition, WorkflowHandler } from "./index.js";
import { StepExecutor, type StepRequest, type WorkerResult } from "./step.js";
import { type WorkflowComponent } from "./types.js";
import { createWorkflowCtx } from "./workflowContext.js";

export type WorkflowArgs<V extends PropertyValidators, Context = unknown> = {
  /**
   * The arguments to pass to the Workflow handler.
   */
  args: ObjectType<V>;
  /**
   * Whether to enqueue the Workflow for asynchronous execution only.
   * By default it will start evaluating the handler's first step in the
   * current transaction.
   */
  startAsync?: boolean;
  /**
   * A function handle (created with createFunctionHandle) that will be called
   * when the Workflow completes.
   */
  onComplete?: FunctionHandle<"mutation", OnCompleteArgs<Context>>;
  /**
   * Any extra context to pass to the Workflow.
   */
  context?: Context;
};
const vWorkflowArgs = v.union(
  v.object({
    workflowId: vWorkflowId,
    generationNumber: v.number(),
  }),
  v.object({
    fn: v.optional(v.string()),
    args: v.any(),
    startAsync: v.optional(v.boolean()),
    onComplete: v.optional(v.string()),
    context: v.optional(v.any()),
  }),
);

// This function is defined in the calling component but then gets passed by
// function handle to the workflow component for execution. This function runs
// one "poll" of the workflow, replaying its execution from the journal until
// it blocks next.
export function workflowMutation<ArgsValidator extends PropertyValidators>(
  component: WorkflowComponent,
  registered: WorkflowDefinition<ArgsValidator> & {
    handler: WorkflowHandler<ArgsValidator, any>;
  },
  defaultWorkpoolOptions?: WorkpoolOptions,
): RegisteredMutation<"internal", WorkflowArgs<ArgsValidator>, WorkflowId> {
  const workpoolOptions = {
    ...defaultWorkpoolOptions,
    ...registered.workpoolOptions,
  };
  return internalMutationGeneric({
    handler: async (ctx, args): Promise<WorkflowId> => {
      if (!validate(vWorkflowArgs, args)) {
        if (!("workflowId" in args) && !("args" in args)) {
          const console = createLogger(workpoolOptions?.logLevel);
          console.error(
            `Invalid arguments for workflow: When calling it directly, use '{ args: { ...your workflow args } }'`,
          );
        }
        assert(validate(vWorkflowArgs, args, { throw: true }));
      }
      let workflowId: WorkflowId, generationNumber: number;

      // Direct call { args: {...}, onComplete?, context?, startAsync? }
      if ("args" in args) {
        const metadata = await getFunctionMetadata();
        // CLI/dashboard format { fn: "path/to:fn", args: {...} } (deprecated)
        if ("fn" in args && typeof args.fn === "string") {
          const console = createLogger(workpoolOptions?.logLevel);
          if (args.fn !== metadata.name) {
            console.error(
              `[workflow] Error: calling workflow with { fn: "${args.fn}", args } ` +
                `but the function name does not match the workflow name ${metadata.name}. Use { args: { ...yourArgs } } without "fn" to start this workflow, ` +
                `or use the start() function.`,
            );
            throw new Error(`Invalid workflow function reference: ${args.fn}`);
          }
          console.warn(
            `[workflow] Deprecation warning: calling a workflow with { fn, args } is deprecated. You no longer need to pass "fn". Use { args: { ...yourArgs } } to start a workflow directly.`,
          );
        }
        const fn = makeFunctionReference(metadata.name);
        const onComplete =
          typeof args.onComplete === "string"
            ? { fnHandle: args.onComplete, context: args.context }
            : undefined;
        workflowId = (await ctx.runMutation(component.workflow.create, {
          workflowName: metadata.name,
          workflowHandle: await createFunctionHandle(fn),
          workflowArgs: args.args,
          maxParallelism: workpoolOptions.maxParallelism,
          onComplete,
          startAsync: args.startAsync ?? undefined,
          createOnly: !args.startAsync, // either start async or run inline here
        })) as WorkflowId;
        if (args.startAsync) {
          return workflowId;
        }
        generationNumber = 0;
      } else {
        workflowId = args.workflowId;
        generationNumber = args.generationNumber;
      }

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
        return workflowId;
      }
      if (workflow.generationNumber !== generationNumber) {
        console.error(
          `Invalid generation number: ${generationNumber} running workflow ${workflow.name} (${workflowId})`,
        );
        return workflowId;
      }
      if (workflow.runResult?.kind === "success") {
        console.log(`Workflow ${workflowId} completed, returning.`);
        return workflowId;
      }
      if (inProgress.length > 0) {
        console.log(
          `Workflow ${workflowId} blocked by ` +
            inProgress
              .map((entry) => `${entry.step.name} (${entry._id})`)
              .join(", "),
        );
        return workflowId;
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
      const restoreEnvironment = setupEnvironment(
        executor.getGenerationState.bind(executor),
        workflowId,
      );
      try {
        const handlerWorker = async (): Promise<WorkerResult> => {
          let runResult: RunResult;
          try {
            if (registered.args) {
              validate(v.object(registered.args), workflow.args, {
                throw: true,
                db: ctx.db,
              });
            }
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
      } finally {
        restoreEnvironment();
      }
      return workflowId;
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE createLogger";

// TODO: replace with ctx.meta.getFunctionMetadata() in 1.36+
export async function getFunctionMetadata(): Promise<{
  name: string;
  componentPath: string;
}> {
  const syscalls = (global as any).Convex;
  return JSON.parse(
    await syscalls.asyncSyscall("1.0/getFunctionMetadata", JSON.stringify({})),
  );
}

type TransactionMetric = {
  used: number;
  remaining: number;
};

type TransactionMetrics = {
  bytesRead: TransactionMetric;
  bytesWritten: TransactionMetric;
  databaseQueries: TransactionMetric;
  documentsRead: TransactionMetric;
  documentsWritten: TransactionMetric;
  functionsScheduled: TransactionMetric;
  scheduledFunctionArgsBytes: TransactionMetric;
};

// TODO: replace with ctx.meta.getFunctionMetadata() in 1.36+
export async function getTransactionMetrics(): Promise<TransactionMetrics> {
  const syscalls = (global as any).Convex;
  return JSON.parse(
    await syscalls.asyncSyscall(
      "1.0/getTransactionMetrics",
      JSON.stringify({}),
    ),
  );
}
