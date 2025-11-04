import type {
  RunResult,
  WorkpoolOptions,
  WorkpoolRetryOptions,
} from "@convex-dev/workpool";
import { parse } from "convex-helpers/validators";
import {
  createFunctionHandle,
  type FunctionArgs,
  type FunctionReference,
  type FunctionVisibility,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type PaginationOptions,
  type PaginationResult,
  type RegisteredMutation,
  type ReturnValueForOptionalValidator,
} from "convex/server";
import type {
  Infer,
  ObjectType,
  PropertyValidators,
  Validator,
} from "convex/values";
import type { Step } from "../component/schema.js";
import type {
  EventId,
  OnCompleteArgs,
  WorkflowId,
  WorkflowStep,
} from "../types.js";
import { safeFunctionName } from "./safeFunctionName.js";
import type { IdsToStrings, WorkflowComponent } from "./types.js";
import type { WorkflowCtx } from "./workflowContext.js";
import { workflowMutation } from "./workflowMutation.js";

export {
  vWorkflowId,
  vWorkflowStep,
  type WorkflowId,
  type WorkflowStep,
} from "../types.js";
export type { RunOptions, WorkflowCtx } from "./workflowContext.js";

export type CallbackOptions = {
  /**
   * A mutation to run after the function succeeds, fails, or is canceled.
   * The context type is for your use, feel free to provide a validator for it.
   * e.g.
   * ```ts
   * export const completion = internalMutation({
   *  args: {
   *    workId: workIdValidator,
   *    context: v.any(),
   *    result: resultValidator,
   *  },
   *  handler: async (ctx, args) => {
   *    console.log(args.result, "Got Context back -> ", args.context, Date.now() - args.context);
   *  },
   * });
   * ```
   */
  onComplete?: FunctionReference<
    "mutation",
    FunctionVisibility,
    OnCompleteArgs
  > | null;

  /**
   * A context object to pass to the `onComplete` mutation.
   * Useful for passing data from the enqueue site to the onComplete site.
   */
  context?: unknown;
};

export type WorkflowDefinition<
  ArgsValidator extends PropertyValidators,
  ReturnsValidator extends Validator<any, "required", any> | void = any,
> = {
  args?: ArgsValidator;
  handler: (
    step: WorkflowCtx,
    args: ObjectType<ArgsValidator>,
  ) => Promise<ReturnValueForOptionalValidator<ReturnsValidator>>;
  returns?: ReturnsValidator;
  workpoolOptions?: WorkpoolRetryOptions;
};

export type WorkflowStatus =
  | { type: "inProgress"; running: IdsToStrings<Step>[] }
  | { type: "completed"; result: unknown }
  | { type: "canceled" }
  | { type: "failed"; error: string };

export class WorkflowManager {
  constructor(
    public component: WorkflowComponent,
    public options?: {
      workpoolOptions: WorkpoolOptions;
    },
  ) {}

  /**
   * Define a new workflow.
   *
   * @param workflow - The workflow definition.
   * @returns The workflow mutation.
   */
  define<
    ArgsValidator extends PropertyValidators,
    ReturnsValidator extends Validator<unknown, "required", string> | void,
  >(
    workflow: WorkflowDefinition<ArgsValidator, ReturnsValidator>,
  ): RegisteredMutation<
    "internal",
    {
      fn: "You should not call this directly, call workflow.start instead";
      args: ObjectType<ArgsValidator>;
    },
    ReturnsValidator extends Validator<unknown, "required", string>
      ? Infer<ReturnsValidator>
      : void
  > {
    return workflowMutation(
      this.component,
      workflow,
      this.options?.workpoolOptions,
    );
  }

  /**
   * Kick off a defined workflow.
   *
   * @param ctx - The Convex context.
   * @param workflow - The workflow to start (e.g. `internal.index.exampleWorkflow`).
   * @param args - The workflow arguments.
   * @returns The workflow ID.
   */
  async start<F extends FunctionReference<"mutation", "internal">>(
    ctx: RunMutationCtx,
    workflow: F,
    args: FunctionArgs<F>["args"],
    options?: CallbackOptions & {
      /**
       * By default, during creation the workflow will be initiated immediately.
       * The benefit is that you catch errors earlier (e.g. passing a bad
       * workflow reference or catch arg validation).
       *
       * With `startAsync` set to true, the workflow will be created but will
       * start asynchronously via the internal workpool.
       * You can use this to queue up a lot of work,
       * or make `start` return faster (you still get a workflowId back).
       * @default false
       */
      startAsync?: boolean;
      /** @deprecated Use `startAsync` instead. */
      validateAsync?: boolean;
    },
  ): Promise<WorkflowId> {
    const handle = await createFunctionHandle(workflow);
    const onComplete = options?.onComplete
      ? {
          fnHandle: await createFunctionHandle(options.onComplete),
          context: options.context,
        }
      : undefined;
    const workflowId = await ctx.runMutation(this.component.workflow.create, {
      workflowName: safeFunctionName(workflow),
      workflowHandle: handle,
      workflowArgs: args,
      maxParallelism: this.options?.workpoolOptions?.maxParallelism,
      onComplete,
      startAsync: options?.startAsync ?? options?.validateAsync,
    });
    return workflowId as unknown as WorkflowId;
  }

  /**
   * Get a workflow's status.
   *
   * @param ctx - The Convex context.
   * @param workflowId - The workflow ID.
   * @returns The workflow status.
   */
  async status(
    ctx: RunQueryCtx,
    workflowId: WorkflowId,
  ): Promise<WorkflowStatus> {
    const { workflow, inProgress } = await ctx.runQuery(
      this.component.workflow.getStatus,
      { workflowId },
    );
    const running = inProgress.map((entry) => entry.step as IdsToStrings<Step>);
    switch (workflow.runResult?.kind) {
      case undefined:
        return { type: "inProgress", running };
      case "canceled":
        return { type: "canceled" };
      case "failed":
        return { type: "failed", error: workflow.runResult.error };
      case "success":
        return { type: "completed", result: workflow.runResult.returnValue };
    }
  }

  /**
   * Cancel a running workflow.
   *
   * @param ctx - The Convex context.
   * @param workflowId - The workflow ID.
   */
  async cancel(ctx: RunMutationCtx, workflowId: WorkflowId) {
    await ctx.runMutation(this.component.workflow.cancel, {
      workflowId,
    });
  }

  /**
   * List the steps in a workflow, including their name, args, return value etc.
   *
   * @param ctx - The Convex context from a query, mutation, or action.
   * @param workflowId - The workflow ID.
   * @param opts - How many steps to fetch and in what order.
   *   e.g. `{ order: "desc", paginationOpts: { cursor: null, numItems: 10 } }`
   *   will get the last 10 steps in descending order.
   *   Defaults to 100 steps in ascending order.
   * @returns The pagination result with per-step data.
   */
  async listSteps(
    ctx: RunQueryCtx,
    workflowId: WorkflowId,
    opts?: {
      order?: "asc" | "desc";
      paginationOpts?: PaginationOptions;
    },
  ): Promise<PaginationResult<WorkflowStep>> {
    const steps = await ctx.runQuery(this.component.workflow.listSteps, {
      workflowId,
      order: opts?.order ?? "asc",
      paginationOpts: opts?.paginationOpts ?? {
        cursor: null,
        numItems: 100,
      },
    });
    return steps as PaginationResult<WorkflowStep>;
  }

  /**
   * Clean up a completed workflow's storage.
   *
   * @param ctx - The Convex context.
   * @param workflowId - The workflow ID.
   * @returns - Whether the workflow's state was cleaned up.
   */
  async cleanup(ctx: RunMutationCtx, workflowId: WorkflowId): Promise<boolean> {
    return await ctx.runMutation(this.component.workflow.cleanup, {
      workflowId,
    });
  }

  /**
   * Send an event to a workflow.
   *
   * @param ctx - From a mutation, action or workflow step.
   * @param args - Either send an event by its ID, or by name and workflow ID.
   *   If you have a validator, you must provide a value.
   *   If you provide an error string, awaiting the event will throw an error.
   */
  async sendEvent<T = null, Name extends string = string>(
    ctx: RunMutationCtx,
    args: (
      | { workflowId: WorkflowId; name: Name; id?: EventId<Name> }
      | { workflowId?: undefined; name?: Name; id: EventId<Name> }
    ) &
      (
        | { validator?: undefined; value?: T }
        | { validator: Validator<T, any, any>; value: T }
        | { error: string; value?: undefined }
      ),
  ): Promise<EventId<Name>> {
    const result: RunResult =
      "error" in args
        ? {
            kind: "failed",
            error: args.error,
          }
        : {
            kind: "success" as const,
            returnValue: args.validator
              ? parse(args.validator, args.value)
              : "value" in args
                ? args.value
                : null,
          };
    return (await ctx.runMutation(this.component.event.send, {
      eventId: args.id,
      result,
      name: args.name,
      workflowId: args.workflowId,
      workpoolOptions: this.options?.workpoolOptions,
    })) as EventId<Name>;
  }

  /**
   * Create an event ahead of time, enabling awaiting a specific event by ID.
   * @param ctx - From an action, mutation or workflow step.
   * @param args - The name of the event and what workflow it belongs to.
   * @returns The event ID, which can be used to send the event or await it.
   */
  async createEvent<Name extends string>(
    ctx: RunMutationCtx,
    args: { name: Name; workflowId: WorkflowId },
  ): Promise<EventId<Name>> {
    return (await ctx.runMutation(this.component.event.create, {
      name: args.name,
      workflowId: args.workflowId,
    })) as EventId<Name>;
  }
}

/**
 * Define an event specification: a name and a validator.
 * This helps share definitions between workflow.sendEvent and ctx.awaitEvent.
 * e.g.
 * ```ts
 * const approvalEvent = defineEvent({
 *   name: "approval",
 *   validator: v.object({ approved: v.boolean() }),
 * });
 * ```
 * Then you can await it in a workflow:
 * ```ts
 * const result = await ctx.awaitEvent(approvalEvent);
 * ```
 * And send from somewhere else:
 * ```ts
 * await workflow.sendEvent(ctx, {
 *   ...approvalEvent,
 *   workflowId,
 *   value: { approved: true },
 * });
 * ```
 */
export function defineEvent<
  Name extends string,
  V extends Validator<unknown, "required", string>,
>(spec: { name: Name; validator: V }) {
  return spec;
}

type RunQueryCtx = {
  runQuery: GenericQueryCtx<GenericDataModel>["runQuery"];
};
type RunMutationCtx = {
  runMutation: GenericMutationCtx<GenericDataModel>["runMutation"];
};
