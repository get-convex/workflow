import { BaseChannel } from "async-channel";
import {
  FunctionReference,
  FunctionArgs,
  FunctionReturnType,
  createFunctionHandle,
  getFunctionName,
} from "convex/server";
import { WorkflowStep } from "./index.js";
import { StepRequest } from "./step.js";
import { FunctionType } from "../types.js";
import { RetryBehavior } from "@convex-dev/workpool";

export class StepContext implements WorkflowStep {
  constructor(private sender: BaseChannel<StepRequest>) {}

  async runQuery<Query extends FunctionReference<"query", any>>(
    query: Query,
    args: FunctionArgs<Query>,
  ): Promise<FunctionReturnType<Query>> {
    return await this.runFunction({ type: "query" }, query, args);
  }

  async runMutation<Mutation extends FunctionReference<"mutation", any>>(
    mutation: Mutation,
    args: FunctionArgs<Mutation>,
  ): Promise<FunctionReturnType<Mutation>> {
    return await this.runFunction({ type: "mutation" }, mutation, args);
  }

  async runAction<Action extends FunctionReference<"action", any>>(
    action: Action,
    args: FunctionArgs<Action>,
    opts?: {
      retry?: RetryBehavior | boolean | undefined;
    },
  ): Promise<FunctionReturnType<Action>> {
    return await this.runFunction({ type: "action" }, action, args, opts);
  }

  async sleep(durationMs: number): Promise<void> {
    let send: any;
    const p = new Promise<void>((resolve, reject) => {
      send = this.sender.push({
        type: "sleep",
        durationMs,
        resolve,
        reject,
      });
    });
    await send;
    return p;
  }

  private async runFunction<F extends FunctionReference<any>>(
    functionType: FunctionType,
    f: F,
    args: any,
    opts?: {
      retry?: RetryBehavior | boolean | undefined;
    },
  ): Promise<any> {
    const handle = await createFunctionHandle(f);
    let send: any;
    const p = new Promise<any>((resolve, reject) => {
      send = this.sender.push({
        type: "function",
        name: getFunctionName(f),
        functionType,
        handle,
        args,
        retry: opts?.retry,
        resolve,
        reject,
      });
    });
    await send;
    return p;
  }
}
