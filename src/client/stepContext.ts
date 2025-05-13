import { BaseChannel } from "async-channel";
import type {
  FunctionReference,
  FunctionArgs,
  FunctionReturnType,
  FunctionType,
} from "convex/server";
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

  async runQuery<Query extends FunctionReference<"query", "internal">>(
    query: Query,
    args: FunctionArgs<Query>,
    opts?: RunOptions,
  ): Promise<FunctionReturnType<Query>> {
    return this.runFunction("query", query, args, opts);
  }

  async runMutation<Mutation extends FunctionReference<"mutation", "internal">>(
    mutation: Mutation,
    args: FunctionArgs<Mutation>,
    opts?: RunOptions,
  ): Promise<FunctionReturnType<Mutation>> {
    return this.runFunction("mutation", mutation, args, opts);
  }

  async runAction<Action extends FunctionReference<"action", "internal">>(
    action: Action,
    args: FunctionArgs<Action>,
    opts?: RunOptions & RetryOption,
  ): Promise<FunctionReturnType<Action>> {
    return this.runFunction("action", action, args, opts);
  }

  async pause<
    Mutation extends FunctionReference<"mutation", any, any, void>,
    Returns = void,
  >(
    pauseHandler: Mutation,
    args: FunctionArgs<Mutation>,
    opts?: RunOptions & { returns: Validator<Returns, "required", any> },
  ): Promise<Returns> {
    return this.runFunction("mutation", pauseHandler, args, {
      ...opts,
      pause: true,
    }) as Promise<Returns>;
  }

  private async runFunction<
    F extends FunctionReference<FunctionType, "internal">,
  >(
    functionType: FunctionType,
    f: F,
    args: unknown,
    opts?: RunOptions & RetryOption & { pause?: true },
  ): Promise<unknown> {
    let send: unknown;
    const { name, retry, pause, ...schedulerOptions } = opts ?? {};
    const p = new Promise<unknown>((resolve, reject) => {
      send = this.sender.push({
        name: name ?? safeFunctionName(f),
        functionType,
        function: f,
        args,
        retry,
        pause,
        schedulerOptions,
        resolve,
        reject,
      });
    });
    await send;
    return p;
  }
}
