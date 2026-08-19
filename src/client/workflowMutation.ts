import { type WorkpoolOptions } from "@convex-dev/workpool";
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
  type Infer,
  type ObjectType,
  type PropertyValidators,
  type Validator,
} from "convex/values";
import {
  createLogger,
  logLevel as logLevelValidator,
  type LogLevel,
} from "../logging.js";
import {
  journalDocument,
  type JournalEntry,
  type Workflow,
  workflowDocument,
} from "../validators.js";
import { formatErrorWithStack } from "../shared.js";
import { vWorkflowId, type OnCompleteArgs, type WorkflowId } from "../types.js";
import {
  normalizeExecutionMode,
  vExecutionMode,
  type ExecutionMode,
} from "../execution.js";
import { setupEnvironment } from "./environment.js";
import type { WorkflowDefinition, WorkflowHandler } from "./index.js";
import { StepExecutor, type StepRequest, type WorkerResult } from "./step.js";
import {
  type InferFromOptionalValidator,
  type WorkflowComponent,
} from "./types.js";
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
  /** Select the durable action runner instead of mutation-by-mutation execution. */
  executionMode?: ExecutionMode;
} & (
  | {
      /**
       * A function handle (created with createFunctionHandle) that will be
       * called when the Workflow completes.
       */
      onComplete: FunctionHandle<"mutation", OnCompleteArgs<Context>>;
      /**
       * Context forwarded to the `onComplete` mutation.
       */
      context: Context;
    }
  | {
      onComplete?: undefined;
      context?: undefined;
    }
);

const vWorkflowArgs = v.union(
  v.object({
    workflowId: vWorkflowId,
    generationNumber: v.number(),
    actionState: v.optional(
      v.object({
        workflow: workflowDocument,
        journalEntries: v.array(journalDocument),
        logLevel: logLevelValidator,
      }),
    ),
  }),
  v.object({
    args: v.any(),
    startAsync: v.optional(v.boolean()),
    onComplete: v.optional(v.string()),
    context: v.optional(v.any()),
    executionMode: v.optional(vExecutionMode),
  }),
);
export type WorkflowMutationArgs = Infer<typeof vWorkflowArgs>;

export type RunResult<Returns = unknown> =
  | { kind: "success"; returnValue: Returns }
  | { kind: "failed"; error: string }
  | { kind: "canceled" };

const vRunResult = (
  returns: Validator<any, "required", any> | PropertyValidators | undefined,
) =>
  v.union(
    v.object({
      kind: v.literal("success"),
      returnValue: returns ? asObjectValidator(returns) : v.any(),
    }),
    v.object({
      kind: v.literal("failed"),
      error: v.string(),
    }),
    v.object({ kind: v.literal("canceled") }),
  );

/**
 * The value returned by the workflow mutation.
 *
 * Direct calls return the workflow ID. Internal polls return `complete` when
 * the handler finishes, carrying its validated result for the workflow driver.
 */
export type WorkflowMutationResult<Returns = unknown> =
  | WorkflowId
  | { kind: "steps"; entries: JournalEntry[] }
  | { kind: "blocked" }
  | { kind: "complete"; runResult: RunResult<Returns> };

const vWorkflowReturns = (
  returns: Validator<any, "required", any> | PropertyValidators | undefined,
) =>
  v.union(
    vWorkflowId,
    v.object({
      kind: v.literal("steps"),
      entries: v.array(journalDocument),
    }),
    v.object({
      kind: v.literal("blocked"),
    }),
    v.object({
      kind: v.literal("complete"),
      runResult: vRunResult(returns),
    }),
  );

// This function is defined in the calling component but then gets passed by
// function handle to the workflow component for execution. This function runs
// one "poll" of the workflow, replaying its execution from the journal until
// it blocks next.
export function workflowMutation<
  ArgsValidator extends PropertyValidators,
  ReturnsValidator extends Validator<any, "required", any> | void,
>(
  component: WorkflowComponent,
  registered: WorkflowDefinition<ArgsValidator, ReturnsValidator> & {
    handler: WorkflowHandler<ArgsValidator, ReturnsValidator>;
  },
  defaultWorkpoolOptions?: WorkpoolOptions,
): RegisteredMutation<
  "internal",
  WorkflowArgs<ArgsValidator>,
  WorkflowMutationResult<InferFromOptionalValidator<ReturnsValidator>>
> {
  const workpoolOptions = {
    ...defaultWorkpoolOptions,
    ...registered.workpoolOptions,
  };
  return internalMutationGeneric({
    args: v.object({
      // Declared on the mutation itself, so that anything deriving types from the
      // validators (static codegen, function specs) sees the real shape.
      //
      // The two shapes are merged into one all-optional object rather than kept as a
      // union b/c Convex args must be an object.
      // The handler re-checks against the real union below, for better errors.
      ...vWorkflowArgs.members[0].partial().fields,
      ...vWorkflowArgs.members[1].partial().fields,
      args: v.optional(asObjectValidator(registered.args ?? v.any())),
      // Never an actual input, exists solely to provide a better error message when
      // the workflow is called directly with args instead of nesting in { args }.
      docs: v.optional(
        v.literal(
          "To call a workflow directly, nest its arguments: { args: { ...yourWorkflowArgs } }",
        ),
      ),
    }),
    returns: vWorkflowReturns(registered.returns ?? undefined),
    handler: async (
      ctx,
      args,
    ): Promise<
      WorkflowMutationResult<InferFromOptionalValidator<ReturnsValidator>>
    > => {
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
      let actionState:
        | {
            workflow: Workflow;
            journalEntries: JournalEntry[];
            logLevel: LogLevel;
          }
        | undefined;

      // Direct call { args: {...}, onComplete?, context?, startAsync? }
      if ("args" in args) {
        const metadata = await ctx.meta.getFunctionMetadata();
        const fn = makeFunctionReference(metadata.name);
        const onComplete =
          typeof args.onComplete === "string"
            ? { fnHandle: args.onComplete, context: args.context }
            : undefined;
        const execution = normalizeExecutionMode(args.executionMode);
        workflowId = (await ctx.runMutation(component.workflow.create, {
          workflowName: metadata.name,
          workflowHandle: await createFunctionHandle(fn),
          workflowArgs: args.args,
          maxParallelism: workpoolOptions.maxParallelism,
          onComplete,
          startAsync: execution ? true : (args.startAsync ?? undefined),
          createOnly: execution ? false : !args.startAsync,
          execution,
          workpoolOptions,
        })) as WorkflowId;
        if (args.startAsync || execution) {
          return workflowId;
        }
        generationNumber = 0;
      } else {
        workflowId = args.workflowId;
        generationNumber = args.generationNumber;
        actionState = "actionState" in args ? args.actionState : undefined;
      }

      const loaded = actionState
        ? { ...actionState, ok: true }
        : await ctx.runQuery(component.journal.load, {
            workflowId,
            shortCircuit: true,
          });
      const { workflow, logLevel, journalEntries, ok } = loaded;
      const inProgress = journalEntries.filter(({ step }) => step.inProgress);
      const console = createLogger(logLevel);
      if (!ok) {
        console.error(`Failed to load journal for ${workflowId}`);
        const runResult = {
          kind: "failed" as const,
          error: "Failed to load journal",
        };
        await ctx.runMutation(component.workflow.complete, {
          workflowId,
          generationNumber,
          runResult,
        });
        return actionState ? { kind: "complete", runResult } : workflowId;
      }
      if (workflow.generationNumber !== generationNumber) {
        console.error(
          `Invalid generation number: ${generationNumber} running workflow ${workflow.name} (${workflowId})`,
        );
        return actionState ? { kind: "blocked" } : workflowId;
      }
      if (workflow.runResult) {
        console.log(`Workflow ${workflowId} completed, returning.`);
        return actionState
          ? { kind: "complete", runResult: workflow.runResult }
          : workflowId;
      }
      if (inProgress.length > 0) {
        console.log(
          `Workflow ${workflowId} blocked by ` +
            inProgress
              .map((entry) => `${entry.step.name} (${entry._id})`)
              .join(", "),
        );
        return actionState ? { kind: "blocked" } : workflowId;
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
        [...(journalEntries as JournalEntry[])],
        channel,
        Date.now(),
        workpoolOptions,
        Boolean(actionState),
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
              validate(asObjectValidator(registered.args), workflow.args, {
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
            if (!("args" in args)) {
              return { kind: "complete", runResult: result.runResult };
            }
            break;
          }
          case "executorBlocked": {
            // Nothing to do, we already started steps in the StepExecutor.
            if (actionState) return { kind: "steps", entries: result.entries };
          }
        }
      } finally {
        restoreEnvironment();
      }
      return actionState ? { kind: "blocked" } : workflowId;
    },
  }) as RegisteredMutation<
    "internal",
    WorkflowArgs<ArgsValidator>,
    WorkflowMutationResult<InferFromOptionalValidator<ReturnsValidator>>
  >;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE createLogger";
