import type { RetryOption } from "@convex-dev/workpool";
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
    ...args: OptionalRestArgs<RunOptions, Query>
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
    ...args: OptionalRestArgs<RunOptions, Mutation>
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
      const { name, ...schedulerOptions } = opts ?? {};
      return run(sender, {
        name: name ?? safeFunctionName(workflow),
        target: {
          kind: "workflow",
          function: workflow,
          args,
        },
        retry: undefined,
        schedulerOptions,
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
  args: unknown,
  opts?: RunOptions & RetryOption,
): Promise<unknown> {
  const { name, retry, ...schedulerOptions } = opts ?? {};
  return run(sender, {
    name: name ?? safeFunctionName(f),
    target: {
      kind: "function",
      functionType,
      function: f,
      args,
    },
    retry,
    schedulerOptions,
  });
}

async function run(
  sender: BaseChannel<StepRequest>,
  request: Omit<StepRequest, "resolve" | "reject">,
): Promise<unknown> {
  let send: unknown;
  const p = new Promise<unknown>((resolve, reject) => {
    send = sender.push({
      ...request,
      resolve,
      reject,
    });
  });
  await send;
  return p;
}
