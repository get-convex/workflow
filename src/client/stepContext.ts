import { BaseChannel } from "async-channel";
import {
  FunctionReference,
  FunctionArgs,
  FunctionReturnType,
  createFunctionHandle,
  getFunctionName,
  FunctionType,
} from "convex/server";
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

  async runQuery<Query extends FunctionReference<"query", any>>(
    query: Query,
    args: FunctionArgs<Query>,
    opts?: NameOption & SchedulerOptions,
  ): Promise<FunctionReturnType<Query>> {
    return this.runFunction("query", query, args, opts);
  }

  async runMutation<Mutation extends FunctionReference<"mutation", any>>(
    mutation: Mutation,
    args: FunctionArgs<Mutation>,
    opts?: NameOption & SchedulerOptions,
  ): Promise<FunctionReturnType<Mutation>> {
    return this.runFunction("mutation", mutation, args, opts);
  }

  async runAction<Action extends FunctionReference<"action", any>>(
    action: Action,
    args: FunctionArgs<Action>,
    opts?: NameOption & SchedulerOptions & RetryOption,
  ): Promise<FunctionReturnType<Action>> {
    return this.runFunction("action", action, args, opts);
  }

  private async runFunction<F extends FunctionReference<any>>(
    functionType: FunctionType,
    f: F,
    args: any,
    opts?: NameOption & SchedulerOptions & RetryOption,
  ): Promise<any> {
    let send: any;
    const { name, ...rest } = opts ?? {};
    const { retry, ...schedulerOptions } = rest;
    const p = new Promise<any>((resolve, reject) => {
      send = this.sender.push({
        name: name ?? getFunctionName(f),
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
