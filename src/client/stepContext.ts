import { BaseChannel } from "async-channel";
import {
  FunctionReference,
  FunctionArgs,
  FunctionReturnType,
  createFunctionHandle,
} from "convex/server";
import { WorkflowStep } from "./index.js";
import { StepRequest } from "./step.js";
import { FunctionType } from "../types.js";

const DEFAULT_MAX_RETRIES = 0;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

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
  ): Promise<FunctionReturnType<Action>> {        
    return await this.runFunction({ type: "action" }, action, args);
  }

  async sleep(durationMs: number): Promise<void> {
    let send: any;
    const p = new Promise<void>((resolve) => {
      send = this.sender.push({ type: "sleep", durationMs, resolve });
    });
    await send;
    return p;
  }

  private async runFunction<F extends FunctionReference<any>>(
    functionType: FunctionType,
    f: F,
    args: any,
  ): Promise<any> {
    const handle = await createFunctionHandle(f);
    let send: any;
    const p = new Promise<any>((resolve, reject) => {
      send = this.sender.push({
        type: "function",
        functionType,
        handle,
        args,
        resolve,
        reject,
      });
    });
    await send;
    return p;
  }
}
