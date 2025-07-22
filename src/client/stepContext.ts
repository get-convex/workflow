import { BaseChannel } from "async-channel";
import {
  FunctionReference,
  FunctionArgs,
  FunctionReturnType,
  FunctionType,
} from "convex/server";
import { safeFunctionName } from "./safeFunctionName.js";
import { WorkflowStep } from "./index.js";
import { StepRequest } from "./step.js";
import {
  NameOption,
  RetryOption,
  SchedulerOptions,
} from "@convex-dev/workpool";

export class StepContext implements WorkflowStep {
  constructor(
    public workflowId: string,
    private sender: BaseChannel<StepRequest>,
  ) {}

  async runQuery<Query extends FunctionReference<"query", "internal">>(
    query: Query,
    args: FunctionArgs<Query>,
    opts?: NameOption & SchedulerOptions,
  ): Promise<FunctionReturnType<Query>> {
    return this.runFunction("query", query, args, opts);
  }

  async runMutation<Mutation extends FunctionReference<"mutation", "internal">>(
    mutation: Mutation,
    args: FunctionArgs<Mutation>,
    opts?: NameOption & SchedulerOptions,
  ): Promise<FunctionReturnType<Mutation>> {
    return this.runFunction("mutation", mutation, args, opts);
  }

  async runAction<Action extends FunctionReference<"action", "internal">>(
    action: Action,
    args: FunctionArgs<Action>,
    opts?: NameOption & SchedulerOptions & RetryOption,
  ): Promise<FunctionReturnType<Action>> {
    return this.runFunction("action", action, args, opts);
  }

  private async runFunction<
    F extends FunctionReference<FunctionType, "internal">,
  >(
    functionType: FunctionType,
    f: F,
    args: unknown,
    opts?: NameOption & SchedulerOptions & RetryOption,
  ): Promise<unknown> {
    let send: unknown;
    const { name, ...rest } = opts ?? {};
    const { retry, ...schedulerOptions } = rest;
    const p = new Promise<unknown>((resolve, reject) => {
      send = this.sender.push({
        name: name ?? safeFunctionName(f),
        functionType,
        function: f,
        args,
        retry,
        schedulerOptions,
        resolve,
        reject,
      });
    });
    await send;
    return p;
  }
}
