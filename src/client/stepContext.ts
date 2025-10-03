import { BaseChannel } from "async-channel";
import type {
  FunctionReference,
  FunctionArgs,
  FunctionReturnType,
  FunctionType,
  DefaultFunctionArgs,
} from "convex/server";
import type { Validator } from "convex/values";
import { safeFunctionName } from "./safeFunctionName.js";
import type { StepRequest } from "./step.js";
import type { RetryOption } from "@convex-dev/workpool";
import type { RunOptions, WorkflowStep } from "./types.js";
import type { WorkflowId } from "../types.js";

export class StepContext implements WorkflowStep {
  constructor(
    public workflowId: WorkflowId,
    private sender: BaseChannel<StepRequest>,
  ) {}

  runQuery<Query extends FunctionReference<"query", "internal">>(
    query: Query,
    args: FunctionArgs<Query>,
    opts?: RunOptions,
  ): Promise<FunctionReturnType<Query>> {
    return this.runFunction("query", query, args, opts);
  }

  runMutation<Mutation extends FunctionReference<"mutation", "internal">>(
    mutation: Mutation,
    args: FunctionArgs<Mutation>,
    opts?: RunOptions,
  ): Promise<FunctionReturnType<Mutation>> {
    return this.runFunction("mutation", mutation, args, opts);
  }

  runAction<Action extends FunctionReference<"action", "internal">>(
    action: Action,
    args: FunctionArgs<Action>,
    opts?: RunOptions & RetryOption,
  ): Promise<FunctionReturnType<Action>> {
    return this.runFunction("action", action, args, opts);
  }

  pause<
    Mutation extends FunctionReference<
      "mutation",
      "internal",
      DefaultFunctionArgs,
      void
    >,
    Returns = unknown,
  >(
    opts?: {
      /**
       * The name for the pause. By default, if you pass in api.foo.bar.baz,
       * it will use "foo/bar:baz" as the name. If you pass in a function handle,
       * it will use the function handle directly. Otherwise it will use "pause".
       */
      name?: string;
      returns: Validator<Returns, "required">;
    } & (
      | { onPause: Mutation; args: FunctionArgs<Mutation> }
      | { onPause?: undefined; args?: undefined }
    ),
  ): Promise<Returns> {
    if (opts?.onPause) {
      return this.runFunction("pause", opts.onPause, opts.args, {
        name: opts.name,
        pause: true,
      }) as Promise<Returns>;
    } else {
      return this.run({
        name: opts?.name ?? "pause",
        functionType: "pause",
        function: undefined,
        args: {},
        retry: undefined,
        pause: true,
        schedulerOptions: {},
      }) as Promise<Returns>;
    }
  }

  private runFunction<F extends FunctionReference<FunctionType, "internal">>(
    functionType: FunctionType | "pause",
    f: F,
    args: unknown,
    opts?: RunOptions & RetryOption & { pause?: true },
  ): Promise<unknown> {
    const { name, retry, pause, ...schedulerOptions } = opts ?? {};
    return this.run({
      name: name ?? (f ? safeFunctionName(f) : "pause"),
      functionType,
      function: f,
      args: args ?? {},
      retry,
      pause,
      schedulerOptions,
    });
  }

  private async run(
    req: Omit<StepRequest, "resolve" | "reject">,
  ): Promise<unknown> {
    let send: unknown;
    const p = new Promise<unknown>((resolve, reject) => {
      send = this.sender.push({
        ...req,
        resolve,
        reject,
      });
    });
    await send;
    return p;
  }
}
