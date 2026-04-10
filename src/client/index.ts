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
import type { ObjectType, PropertyValidators, Validator } from "convex/values";
import type { Step } from "../component/schema.js";
import type {
  EventId,
  OnCompleteArgs,
  PublicWorkflow,
  WorkflowId,
  WorkflowStep,
} from "../types.js";
import { safeFunctionName } from "./safeFunctionName.js";
import type { IdsToStrings, WorkflowComponent } from "./types.js";
export type { WorkflowComponent } from "./types.js";
import type { WorkflowCtx } from "./workflowContext.js";
import { workflowMutation, type WorkflowArgs } from "./workflowMutation.js";

export {
  vEventId,
  vWorkflowId,
  vWorkflowStep,
  type EventId,
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
  returns?: ReturnsValidator;
  workpoolOptions?: WorkpoolRetryOptions;
};

export type WorkflowHandler<
  ArgsValidator extends PropertyValidators,
  ReturnsValidator extends Validator<any, "required", any> | void,
> = (
  step: WorkflowCtx,
  args: ObjectType<ArgsValidator>,
) => Promise<ReturnValueForOptionalValidator<ReturnsValidator>>;

export type WorkflowStatus =
  | { type: "inProgress"; running: IdsToStrings<Step>[] }
  | { type: "completed"; result: unknown }
  | { type: "canceled" }
  | { type: "failed"; error: string };

/**
 * Define a new workflow with typed args and optional return validator.
 *
 *
 * @example
 * ```ts
 * export const doSomething = workflow.define({
 *   args: { amount: v.number() },
 *   returns: v.object({ total: v.number() }),
 * }).handler(async (step, args) => {
 *   ...workflow implementation
 * });
 *
 * // Start from a mutation or action:
 * const id = await workflow.start(ctx, internal.myFile.myWorkflow, { amount });
 * ```
 *
 * Alternatively, you can define the workflow spec separately from the handler,
 * giving you an object to call ``.start` on directly:
 *
 * ```ts
 * const doSomethingWorkflow = defineWorkflow({
 *   args: { foo: v.string()  },
 *   returns: v.boolean(),
 * }).withHandlerRef(internal.myFile.doSomething);
 *
 * export const doSomething = myWorkflow.handler(async (step, args) => {
 *    ...workflow implementation
 * });
 *
 * // Start from a mutation or action:
 * const id = await doSomethingWorkflow.start(ctx, { foo });
 * ```
 */
export function defineWorkflow<
  AV extends PropertyValidators,
  RV extends Validator<any, "required", any> | void = void,
>(
  component: WorkflowComponent,
  config: WorkflowDefinition<AV, RV>,
): {
  /**
   * Define the workflow handler function.
   * Returns a registered mutation to export from your Convex module.
   */
  handler(
    fn: (
      step: WorkflowCtx,
      args: ObjectType<AV>,
    ) => Promise<ReturnValueForOptionalValidator<RV>>,
  ): RegisteredMutation<
    "internal",
    WorkflowArgs<AV>,
    ReturnValueForOptionalValidator<RV>
  >;
  /**
   * Bind the workflow to its handler function's reference.
   * Returns a Workflow with `.handler()` and `.start()`.
   *
   * Example: `workflow.define({...}).withHandlerRef(internal.myFile.myHandler)`
   */
  withHandlerRef(
    ref: FunctionReference<
      "mutation",
      "internal",
      WorkflowArgs<AV>,
      ReturnValueForOptionalValidator<RV>
    >,
  ): Workflow<AV, RV>;
} {
  return {
    handler: (fn) =>
      workflowMutation(component, { ...config, handler: fn }, undefined),
    withHandlerRef: (ref) => {
      const refName = safeFunctionName(ref);
      return {
        handler: (fn) =>
          workflowMutation(
            component,
            { ...config, handler: fn },
            undefined,
            refName,
          ),
        async start(ctx, args, options?) {
          const handle = await createFunctionHandle(ref);
          const onComplete = options?.onComplete
            ? {
                fnHandle: await createFunctionHandle(options.onComplete),
                context: options.context,
              }
            : undefined;
          const workflowId = await ctx.runMutation(component.workflow.create, {
            workflowName: safeFunctionName(ref),
            workflowHandle: handle,
            workflowArgs: args,
            onComplete,
            startAsync: options?.startAsync,
          });
          return workflowId as unknown as WorkflowId;
        },
      };
    },
  };
}

export interface Workflow<
  AV extends PropertyValidators,
  RV extends Validator<any, "required", any> | void,
> {
  /**
   * Define the workflow handler function.
   * Returns a registered mutation to export from your Convex module.
   */
  handler(
    fn: (
      step: WorkflowCtx,
      args: ObjectType<AV>,
    ) => Promise<ReturnValueForOptionalValidator<RV>>,
  ): RegisteredMutation<
    "internal",
    WorkflowArgs<AV>,
    ReturnValueForOptionalValidator<RV>
  >;

  /**
   * Kick off a defined workflow.
   *
   * @param ctx - The Convex context.
   * @param args - The workflow arguments.
   * @param options - The workflow options.
   * @returns The workflow ID.
   */
  start(
    ctx: RunMutationCtx,
    args: ObjectType<AV>,
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
    },
  ): Promise<WorkflowId>;
}

// ── Standalone workflow management functions ─────────────────────────
// These take ctx first, then a workflow component, so they can be
// used without a WorkflowManager instance.

/**
 * Get a workflow's status.
 *
 * @param ctx - The Convex context.
 * @param component - The workflow component.
 * @param workflowId - The workflow ID.
 * @returns The workflow status.
 */
export async function getStatus(
  ctx: RunQueryCtx,
  component: WorkflowComponent,
  workflowId: WorkflowId,
): Promise<WorkflowStatus> {
  const { workflow, inProgress } = await ctx.runQuery(
    component.workflow.getStatus,
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
 * @param component - The workflow component.
 * @param workflowId - The workflow ID.
 */
export async function cancel(
  ctx: RunMutationCtx,
  component: WorkflowComponent,
  workflowId: WorkflowId,
): Promise<void> {
  await ctx.runMutation(component.workflow.cancel, { workflowId });
}

/**
 * Restart a previously-failed workflow.
 *
 * By default it will retry the handler using the existing history of steps.
 * To restart from the beginning, pass `{from: 0}`.
 * To restart from a named step or event: `{from: "myName"}`.
 * To restart from a function call: `{from: internal.foo.bar}`.
 *
 * If the function or name were called multiple times, it will restart from
 * the last invocation.
 *
 * @param ctx - The Convex context.
 * @param component - The workflow component.
 * @param workflowId - The workflow ID.
 * @param options - Options for the retry.
 * @param options.from - The step to retry from. Can be a step number,
 *   a step name, or the function / workflow `internal.foo.bar`.
 *   Steps from this point onwards will be deleted before restarting.
 *   If not provided, the handler will be re-executed using the existing
 *   history of steps.
 * @param options.startAsync - If true, the workflow will be enqueued
 *   via the workpool instead of running immediately.
 */
export async function restart(
  ctx: RunMutationCtx,
  component: WorkflowComponent,
  workflowId: WorkflowId,
  options?: {
    from?: number | string | FunctionReference<any, any>;
    startAsync?: boolean;
  },
): Promise<void> {
  let from: number | string | undefined;
  if (options?.from !== undefined) {
    if (typeof options.from === "number" || typeof options.from === "string") {
      from = options.from;
    } else {
      from = safeFunctionName(options.from);
    }
  }
  await ctx.runMutation(component.workflow.restart, {
    workflowId,
    from,
    startAsync: options?.startAsync,
  });
}

/**
 * Send an event to a workflow.
 *
 * @param ctx - From a mutation, action or workflow step.
 * @param component - The workflow component.
 * @param args - Either send an event by its ID, or by name and workflow ID.
 *   If you have a validator, you must provide a value.
 *   If you provide an error string, awaiting the event will throw an error.
 */
export async function sendEvent<T = null, Name extends string = string>(
  ctx: RunMutationCtx,
  component: WorkflowComponent,
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
      ? { kind: "failed", error: args.error }
      : {
          kind: "success" as const,
          returnValue: args.validator
            ? parse(args.validator, args.value)
            : "value" in args
              ? args.value
              : null,
        };
  return (await ctx.runMutation(component.event.send, {
    eventId: args.id,
    result,
    name: args.name,
    workflowId: args.workflowId,
  })) as EventId<Name>;
}

/**
 * Create an event ahead of time, enabling awaiting a specific event by ID.
 * @param ctx - From an action, mutation or workflow step.
 * @param component - The workflow component.
 * @param args - The name of the event and what workflow it belongs to.
 * @returns The event ID, which can be used to send the event or await it.
 */
export async function createEvent<Name extends string>(
  ctx: RunMutationCtx,
  component: WorkflowComponent,
  args: { name: Name; workflowId: WorkflowId },
): Promise<EventId<Name>> {
  return (await ctx.runMutation(component.event.create, {
    name: args.name,
    workflowId: args.workflowId,
  })) as EventId<Name>;
}

/**
 * List workflows, including their name, args, return value etc.
 *
 * @param ctx - The Convex context from a query, mutation, or action.
 * @param component - The workflow component.
 * @param opts - How many workflows to fetch and in what order.
 *   e.g. `{ order: "desc", paginationOpts: { cursor: null, numItems: 10 } }`
 *   will get the last 10 workflows in descending order.
 *   Defaults to 100 workflows in ascending order.
 * @returns The pagination result with per-workflow data.
 */
export async function list(
  ctx: RunQueryCtx,
  component: WorkflowComponent,
  opts?: {
    order?: "asc" | "desc";
    paginationOpts?: PaginationOptions;
  },
): Promise<PaginationResult<PublicWorkflow>> {
  const workflows = await ctx.runQuery(component.workflow.list, {
    order: opts?.order ?? "asc",
    paginationOpts: opts?.paginationOpts ?? {
      cursor: null,
      numItems: 100,
    },
  });
  return workflows as PaginationResult<PublicWorkflow>;
}

/**
 * List workflows matching a specific name, including their args, return value etc.
 *
 * @param ctx - The Convex context from a query, mutation, or action.
 * @param component - The workflow component.
 * @param name - The workflow name to filter by.
 * @param opts - How many workflows to fetch and in what order.
 *   e.g. `{ order: "desc", paginationOpts: { cursor: null, numItems: 10 } }`
 *   will get the last 10 workflows in descending order.
 *   Defaults to 100 workflows in ascending order.
 * @returns The pagination result with per-workflow data.
 */
export async function listByName(
  ctx: RunQueryCtx,
  component: WorkflowComponent,
  name: string,
  opts?: {
    order?: "asc" | "desc";
    paginationOpts?: PaginationOptions;
  },
): Promise<PaginationResult<PublicWorkflow>> {
  const workflows = await ctx.runQuery(component.workflow.listByName, {
    name,
    order: opts?.order ?? "asc",
    paginationOpts: opts?.paginationOpts ?? {
      cursor: null,
      numItems: 100,
    },
  });
  return workflows as PaginationResult<PublicWorkflow>;
}

/**
 * List the steps in a workflow, including their name, args, return value etc.
 *
 * @param ctx - The Convex context from a query, mutation, or action.
 * @param component - The workflow component.
 * @param workflowId - The workflow ID.
 * @param opts - How many steps to fetch and in what order.
 *   e.g. `{ order: "desc", paginationOpts: { cursor: null, numItems: 10 } }`
 *   will get the last 10 steps in descending order.
 *   Defaults to 100 steps in ascending order.
 * @returns The pagination result with per-step data.
 */
export async function listSteps(
  ctx: RunQueryCtx,
  component: WorkflowComponent,
  workflowId: WorkflowId,
  opts?: {
    order?: "asc" | "desc";
    paginationOpts?: PaginationOptions;
  },
): Promise<PaginationResult<WorkflowStep>> {
  const steps = await ctx.runQuery(component.workflow.listSteps, {
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
 * @param component - The workflow component.
 * @param workflowId - The workflow ID.
 * @returns - Whether the workflow's state was cleaned up.
 */
export async function cleanup(
  ctx: RunMutationCtx,
  component: WorkflowComponent,
  workflowId: WorkflowId,
): Promise<boolean> {
  return await ctx.runMutation(component.workflow.cleanup, {
    workflowId,
  });
}

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
    workflow: WorkflowDefinition<ArgsValidator, ReturnsValidator> & {
      handler: WorkflowHandler<ArgsValidator, ReturnsValidator>;
    },
  ): RegisteredMutation<
    "internal",
    WorkflowArgs<ArgsValidator>,
    ReturnValueForOptionalValidator<ReturnsValidator>
  >;
  define<
    ArgsValidator extends PropertyValidators,
    ReturnsValidator extends Validator<unknown, "required", string> | void,
  >(
    workflow: WorkflowDefinition<ArgsValidator, ReturnsValidator>,
  ): {
    /**
     * Define the workflow handler function.
     * Returns a registered mutation to export from your Convex module.
     */
    handler(
      fn: (
        step: WorkflowCtx,
        args: ObjectType<ArgsValidator>,
      ) => Promise<ReturnValueForOptionalValidator<ReturnsValidator>>,
    ): RegisteredMutation<
      "internal",
      WorkflowArgs<ArgsValidator>,
      ReturnValueForOptionalValidator<ReturnsValidator>
    >;
    /**
     * Bind the workflow to its handler function's reference.
     * Returns a Workflow with `.handler()` and `.start()`.
     */
    withHandlerRef(
      ref: FunctionReference<
        "mutation",
        "internal",
        WorkflowArgs<ArgsValidator>,
        ReturnValueForOptionalValidator<ReturnsValidator>
      >,
    ): Workflow<ArgsValidator, ReturnsValidator>;
  };
  define<
    ArgsValidator extends PropertyValidators,
    ReturnsValidator extends Validator<unknown, "required", string> | void,
  >(
    workflow: WorkflowDefinition<ArgsValidator, ReturnsValidator> & {
      handler?: WorkflowHandler<ArgsValidator, ReturnsValidator>;
    },
  ): unknown {
    if (workflow.handler) {
      return workflowMutation(
        this.component,
        workflow as WorkflowDefinition<ArgsValidator, ReturnsValidator> & {
          handler: WorkflowHandler<ArgsValidator, ReturnsValidator>;
        },
        this.options?.workpoolOptions,
      );
    }
    // Note: we're passing through more options than defineWorkflow claims
    // to support, in order to get the maxParallelism / etc. in there.
    // Direct users of defineWorkflow should instead configure those values
    // via configuring the component directly.
    return defineWorkflow<ArgsValidator, ReturnsValidator>(this.component, {
      ...workflow,
      workpoolOptions: {
        ...this.options?.workpoolOptions,
        ...workflow.workpoolOptions,
      },
    });
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
  async getStatus(
    ctx: RunQueryCtx,
    workflowId: WorkflowId,
  ): Promise<WorkflowStatus> {
    return getStatus(ctx, this.component, workflowId);
  }

  /**
   * Restart a previously-failed workflow.
   *
   * By default it will retry the handler using the existing history of steps.
   * To restart from the beginning, pass `{from: 0}`.
   * To restart from a named step or event: `{from: "myName"}`.
   * To restart from a function call: `{from: internal.foo.bar}`.
   *
   * If the function or name were called multiple times, it will restart from
   * the last invocation.
   *
   * @param ctx - The Convex context.
   * @param workflowId - The workflow ID.
   * @param options - Options for the retry.
   * @param options.from - The step to retry from. Can be a step number,
   *   a step name, or the function / workflow `internal.foo.bar`.
   *   Steps from this point onwards will be deleted before restarting.
   *   If not provided, the handler will be re-executed using the existing
   *   history of steps.
   * @param options.startAsync - If true, the workflow will be enqueued
   *   via the workpool instead of running immediately.
   */
  async restart(
    ctx: RunMutationCtx,
    workflowId: WorkflowId,
    options?: {
      from?: number | string | FunctionReference<any, any>;
      startAsync?: boolean;
    },
  ): Promise<void> {
    return restart(ctx, this.component, workflowId, options);
  }

  /**
   * Cancel a running workflow.
   *
   * @param ctx - The Convex context.
   * @param workflowId - The workflow ID.
   */
  async cancel(ctx: RunMutationCtx, workflowId: WorkflowId) {
    return cancel(ctx, this.component, workflowId);
  }

  /**
   * List workflows, including their name, args, return value etc.
   *
   * @param ctx - The Convex context from a query, mutation, or action.
   * @param opts - How many workflows to fetch and in what order.
   *   e.g. `{ order: "desc", paginationOpts: { cursor: null, numItems: 10 } }`
   *   will get the last 10 workflows in descending order.
   *   Defaults to 100 workflows in ascending order.
   * @returns The pagination result with per-workflow data.
   */
  async list(
    ctx: RunQueryCtx,
    opts?: {
      order?: "asc" | "desc";
      paginationOpts?: PaginationOptions;
    },
  ): Promise<PaginationResult<PublicWorkflow>> {
    return list(ctx, this.component, opts);
  }

  /**
   * List workflows matching a specific name, including their args, return value etc.
   *
   * @param ctx - The Convex context from a query, mutation, or action.
   * @param name - The workflow name to filter by.
   * @param opts - How many workflows to fetch and in what order.
   *   e.g. `{ order: "desc", paginationOpts: { cursor: null, numItems: 10 } }`
   *   will get the last 10 workflows in descending order.
   *   Defaults to 100 workflows in ascending order.
   * @returns The pagination result with per-workflow data.
   */
  async listByName(
    ctx: RunQueryCtx,
    name: string,
    opts?: {
      order?: "asc" | "desc";
      paginationOpts?: PaginationOptions;
    },
  ): Promise<PaginationResult<PublicWorkflow>> {
    return listByName(ctx, this.component, name, opts);
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
    return listSteps(ctx, this.component, workflowId, opts);
  }

  /**
   * Clean up a completed workflow's storage.
   *
   * @param ctx - The Convex context.
   * @param workflowId - The workflow ID.
   * @returns - Whether the workflow's state was cleaned up.
   */
  async cleanup(ctx: RunMutationCtx, workflowId: WorkflowId): Promise<boolean> {
    return cleanup(ctx, this.component, workflowId);
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
    return sendEvent<T, Name>(ctx, this.component, args);
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
    return createEvent(ctx, this.component, args);
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
