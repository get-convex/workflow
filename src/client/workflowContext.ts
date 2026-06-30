import type { RetryOption, RunResult } from "@convex-dev/workpool";
import { BaseChannel } from "async-channel";
import { parse } from "convex-helpers/validators";
import type {
  ArgsAndOptions,
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
import type { TransactionLimits } from "./types.js";
import { assert } from "convex-helpers";

export type EventNameOrId =
  | { name?: string; id: EventId }
  | { id?: EventId; name: string };

export type RaceResult<
  T extends ReadonlyArray<
    EventNameOrId & {
      validator?: Validator<any, any, any>;
    }
  >,
> = {
  [K in keyof T]: T[K] extends {
    name: infer N extends string;
    validator: Validator<infer V, any, any>;
  }
    ? { id: EventId; name: N; value: V }
    : T[K] extends { name: infer N extends string }
      ? { id: EventId; name: N; value: unknown }
      : { id: EventId; name: string; value: unknown };
}[number];

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

type InlineArgs =
  | {
      inline: true;
      runAt?: never;
      runAfter?: never;
      /**
       * Per-transaction resource limits enforced on this inline step's
       * transaction. Exceeding a limit throws a catchable error in the
       * workflow handler.
       *
       * **Requires Convex >= 1.41.** Only supported for `inline` steps.
       */
      transactionLimits?: TransactionLimits;
    }
  | {
      inline?: false;
      /** @deprecated `transactionLimits` is only supported when `inline` is true. */
      transactionLimits?: TransactionLimits;
    };

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
    ...args: ArgsAndOptions<Query, RunOptions & InlineArgs>
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
    ...args: ArgsAndOptions<Mutation, RunOptions & InlineArgs>
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
    ...args: ArgsAndOptions<Action, RunOptions & RetryOption>
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

  /**
   * Waits for any one of multiple events, returning the first that fires.
   *
   * Each event in the array must have a unique name. The workflow blocks
   * until an event with one of the given names is sent, then returns the
   * matched event's name and value.
   *
   * @param events - Array of event definitions, each with a unique `name`
   *   and an optional `validator` to parse the event's payload.
   * @param opts - Optional options, including a custom step `name` for
   *   observability (defaults to `"race(name1, name2, ...)"`) and a
   *   `timeout` in milliseconds after which the race rejects with an error.
   */
  raceEvents<
    const T extends ReadonlyArray<
      EventNameOrId & {
        validator?: Validator<any, any, any>;
      }
    >,
  >(
    events: T,
    opts?: {
      name?: string;
      timeout?: number;
      failure?: "fail" | "retry" | "discard";
    },
  ): Promise<RaceResult<T>>;
};

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
        transactionLimits: undefined,
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
        transactionLimits: undefined,
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
        transactionLimits: undefined,
      });
      if (event.validator) {
        return parse(event.validator, result);
      }
      return result as any;
    },

    raceEvents: async <
      T extends ReadonlyArray<
        EventNameOrId & {
          validator?: Validator<any, any, any>;
        }
      >,
    >(
      events: T,
      opts?: {
        name?: string;
        timeout?: number;
        failure?: "fail" | "retry" | "discard";
      },
    ) => {
      assert(events.length > 0, "At least one event must be specified.");
      assert(
        new Set(events.map((e) => e.id ?? e.name)).size === events.length,
        "All events must have a unique name or id.",
      );
      assert(
        opts?.timeout === undefined ||
          (opts.timeout > 0 && Number.isFinite(opts.timeout)),
        "Timeout must be a positive number.",
      );
      assert(
        events.every((e) => e.id || e.name),
        "All events must have an ID or a name.",
      );
      const result = await run(sender, {
        name:
          opts?.name ?? `race(${events.map((e) => e.name ?? e.id).join(", ")})`,
        target: {
          kind: "race",
          args: {
            events: events.map(({ validator: _validator, ...rest }) => rest),
            timeout: opts?.timeout,
            failure: opts?.failure,
          },
        },
        retry: undefined,
        inline: false,
        unstableArgs: false,
        schedulerOptions: {},
        transactionLimits: undefined,
      });
      const eventId = (result as any).eventId as EventId;
      const eventName = (result as any).eventName as string;
      const rawValue = (result as any).value;
      // Prefer matching the winning spec by id (events raced by id may not
      // carry a name), falling back to the event's name.
      const winner =
        events.find((e) => e.id !== undefined && e.id === eventId) ??
        events.find((e) => e.name === eventName);
      return {
        id: eventId,
        name: eventName,
        value: winner?.validator ? parse(winner.validator, rawValue) : rawValue,
      } as RaceResult<T>;
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
  opts?: RunOptions & {
    inline?: boolean;
    transactionLimits?: TransactionLimits;
  } & RetryOption,
): Promise<unknown> {
  const {
    name,
    retry,
    inline,
    transactionLimits,
    unstableArgs,
    ...schedulerOptions
  } = opts ?? {};
  if (
    inline &&
    schedulerOptions &&
    (schedulerOptions.runAt || schedulerOptions.runAfter)
  ) {
    throw new Error("Cannot combine `inline` with `runAt` or `runAfter`.");
  }
  if (inline && functionType === "action") {
    throw new Error("Cannot run an action inline.");
  }
  if (!inline && transactionLimits) {
    throw new Error("Cannot set transaction limits for non-inline functions.");
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
    transactionLimits,
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
