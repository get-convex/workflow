import type { RetryOption, RunResult } from "@convex-dev/workpool";
import { BaseChannel } from "async-channel";
import { parse } from "convex-helpers/validators";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  FunctionType,
  FunctionVisibility,
} from "convex/server";
import type { Validator } from "convex/values";
import type { EventId, SchedulerOptions, WorkflowId } from "../types.js";
import { safeFunctionName } from "./safeFunctionName.js";
import type { StepRequest } from "./step.js";

export type RunOptions = {
  /**
   * The name of the function. By default, if you pass in api.foo.bar.baz,
   * it will use "foo/bar:baz" as the name. If you pass in a function handle,
   * it will use the function handle directly.
   */
  name?: string;
  /**
   * If true, the journal will not validate that the arguments match on replay.
   * This is useful when arguments are non-deterministic (e.g. derived from
   * a stack trace caught in the workflow) and you want to allow the workflow to
   * replay successfully despite argument changes.
   */
  unstableArgs?: boolean;
} & SchedulerOptions;

export type WorkflowCtx = {
  /**
   * The ID of the workflow currently running.
   */
  workflowId: WorkflowId;
  /**
   * Run a query with the given name and arguments.
   *
   * @param query - The query to run, like `internal.index.exampleQuery`.
   * @param args - The arguments to the query function.
   * @param opts - Options for scheduling and naming the query.
   */
  runQuery<Query extends FunctionReference<"query", FunctionVisibility>>(
    query: Query,
    ...args: OptionalRestArgs<RunOptions & { inline?: boolean }, Query>
  ): Promise<FunctionReturnType<Query>>;

  /**
   * Run a mutation with the given name and arguments.
   *
   * @param mutation - The mutation to run, like `internal.index.exampleMutation`.
   * @param args - The arguments to the mutation function.
   * @param opts - Options for scheduling and naming the mutation.
   */
  runMutation<
    Mutation extends FunctionReference<"mutation", FunctionVisibility>,
  >(
    mutation: Mutation,
    ...args: OptionalRestArgs<RunOptions & { inline?: boolean }, Mutation>
  ): Promise<FunctionReturnType<Mutation>>;

  /**
   * Run an action with the given name and arguments.
   *
   * @param action - The action to run, like `internal.index.exampleAction`.
   * @param args - The arguments to the action function.
   * @param opts - Options for retrying, scheduling and naming the action.
   */
  runAction<Action extends FunctionReference<"action", FunctionVisibility>>(
    action: Action,
    ...args: OptionalRestArgs<RunOptions & RetryOption, Action>
  ): Promise<FunctionReturnType<Action>>;

  /**
   * Run a workflow with the given name and arguments.
   *
   * @param workflow - The workflow to run, like `internal.index.exampleWorkflow`.
   * @param args - The arguments to the workflow function.
   * @param opts - Options for retrying, scheduling and naming the workflow.
   */
  runWorkflow<Workflow extends FunctionReference<"mutation", "internal">>(
    workflow: Workflow,
    args: FunctionArgs<Workflow>["args"],
    opts?: RunOptions,
  ): Promise<FunctionReturnType<Workflow>>;

  /**
   * Blocks until a matching event is sent to this workflow.
   *
   * If an ID is specified, an event with that ID must already exist and must
   * not already be "awaited" or "consumed".
   *
   * If a name is specified, the first available event is consumed that matches
   * the name. If there is no available event, it will create one with that name
   * with status "awaited".
   * @param event
   */
  awaitEvent<T = unknown, Name extends string = string>(
    event: (
      | { name: Name; id?: EventId<Name> }
      | { name?: Name; id: EventId<Name> }
    ) & {
      validator?: Validator<T, any, any>;
    },
  ): Promise<T>;

  /**
   * Suspend execution for the given duration.
   *
   * @param duration - The number of milliseconds to sleep.
   * @param opts - Optionally name the step. Default: "sleep"
   */
  sleep(duration: number, opts?: { name?: string }): Promise<void>;
};

export type OptionalRestArgs<
  Opts,
  FuncRef extends FunctionReference<FunctionType, FunctionVisibility>,
> =
  FuncRef["_args"] extends Record<string, never>
    ? [args?: Record<string, never>, opts?: Opts]
    : [args: FuncRef["_args"], opts?: Opts];

export function createWorkflowCtx(
  workflowId: WorkflowId,
  sender: BaseChannel<StepRequest>,
) {
  return {
    workflowId,
    runQuery: async (query, args, opts?) => {
      return runFunction(sender, "query", query, args, opts);
    },

    runMutation: async (mutation, args, opts?) => {
      return runFunction(sender, "mutation", mutation, args, opts);
    },

    runAction: async (action, args, opts?) => {
      return runFunction(sender, "action", action, args, opts);
    },

    runWorkflow: async (workflow, args, opts?) => {
      const { name, unstableArgs, ...schedulerOptions } = opts ?? {};
      return run(sender, {
        name: name ?? safeFunctionName(workflow),
        target: {
          kind: "workflow",
          function: workflow,
          args,
        },
        retry: undefined,
        inline: false,
        unstableArgs: unstableArgs ?? false,
        schedulerOptions,
      });
    },

    sleep: async (duration, opts?) => {
      await run(sender, {
        name: opts?.name ?? "sleep",
        target: {
          kind: "sleep",
          args: {},
        },
        retry: undefined,
        inline: false,
        unstableArgs: false,
        schedulerOptions: { runAfter: duration },
      });
    },

    awaitEvent: async (event) => {
      const result = await run(sender, {
        name: event.name ?? event.id ?? "Event",
        target: {
          kind: "event",
          args: { eventId: event.id },
        },
        retry: undefined,
        inline: false,
        unstableArgs: false,
        schedulerOptions: {},
      });
      if (event.validator) {
        return parse(event.validator, result);
      }
      return result as any;
    },
  } satisfies WorkflowCtx;
}

async function runFunction<
  F extends FunctionReference<FunctionType, FunctionVisibility>,
>(
  sender: BaseChannel<StepRequest>,
  functionType: FunctionType,
  f: F,
  args: Record<string, unknown> | undefined,
  opts?: RunOptions & { inline?: boolean } & RetryOption,
): Promise<unknown> {
  const { name, retry, inline, unstableArgs, ...schedulerOptions } = opts ?? {};
  if (
    inline &&
    ("runAt" in schedulerOptions || "runAfter" in schedulerOptions)
  ) {
    throw new Error("Cannot combine `inline` with `runAt` or `runAfter`.");
  }
  if (inline && functionType === "action") {
    throw new Error("Cannot run an action inline.");
  }
  return run(sender, {
    name: name ?? safeFunctionName(f),
    target: {
      kind: "function",
      functionType,
      function: f,
      args: args ?? {},
    },
    retry,
    inline: inline ?? false,
    unstableArgs: unstableArgs ?? false,
    schedulerOptions,
  });
}

async function run(
  sender: BaseChannel<StepRequest>,
  request: Omit<StepRequest, "resolve">,
): Promise<unknown> {
  let send: Promise<void>;
  const p = new Promise<RunResult>((resolve) => {
    send = sender.push({
      ...request,
      resolve,
    });
  });
  await send!;
  const result = await p;
  switch (result.kind) {
    case "success":
      return result.returnValue;
    case "failed":
      throw new Error(result.error);
    case "canceled":
      throw new Error("Canceled");
    default:
      throw new Error("Unknown result kind: " + (result as any).kind);
  }
}
