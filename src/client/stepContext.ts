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
import type { RunOptions, WorkflowCtx } from "./types.js";
import type { EventSpec, WorkflowId } from "../types.js";
import { parse } from "convex-helpers/validators";

export class StepContext implements WorkflowCtx {
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

  async runWorkflow<Workflow extends FunctionReference<"mutation", "internal">>(
    workflow: Workflow,
    args: FunctionArgs<Workflow>,
    opts?: RunOptions,
  ): Promise<FunctionReturnType<Workflow>> {
    const { name, ...schedulerOptions } = opts ?? {};
    return this.run({
      name: name ?? safeFunctionName(workflow),
      target: {
        kind: "workflow",
        function: workflow,
        args,
      },
      retry: undefined,
      schedulerOptions,
    });
  }

  async awaitEvent<T, Name extends string = string>(
    event: EventSpec<Name, T>,
  ): Promise<T> {
    const result = await this.run({
      name: event.name,
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
    return result as T;
  }

  private async runFunction<
    F extends FunctionReference<FunctionType, "internal">,
  >(
    functionType: FunctionType,
    f: F,
    args: unknown,
    opts?: RunOptions & RetryOption,
  ): Promise<unknown> {
    const { name, retry, ...schedulerOptions } = opts ?? {};
    return this.run({
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

  private async run(
    request: Omit<StepRequest, "resolve" | "reject">,
  ): Promise<unknown> {
    let send: unknown;
    const p = new Promise<unknown>((resolve, reject) => {
      send = this.sender.push({
        ...request,
        resolve,
        reject,
      });
    });
    await send;
    return p;
  }
}
