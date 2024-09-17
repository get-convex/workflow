import {
  createFunctionHandle,
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  RegisteredMutation,
} from "convex/server";
import { ObjectType, PropertyValidators } from "convex/values";
import { api } from "../component/_generated/api.js";
import { UseApi, WorkflowId } from "../types.js";
import { workflowMutation } from "./workflowMutation.js";

export interface WorkflowStep {
  /**
   * Run a query and wait for the result.
   *
   * @param query - The query to run.
   * @param args - The query arguments.
   * @returns The query result.
   */
  runQuery<Query extends FunctionReference<"query", any>>(
    query: Query,
    args: FunctionArgs<Query>,
  ): Promise<FunctionReturnType<Query>>;

  /**
   * Run a mutation and wait for the result.
   *
   * @param mutation - The mutation to run.
   * @param args - The mutation arguments.
   * @returns The mutation result.
   */

  runMutation<Mutation extends FunctionReference<"mutation", any>>(
    mutation: Mutation,
    args: FunctionArgs<Mutation>,
  ): Promise<FunctionReturnType<Mutation>>;

  /**
   * Run an action and wait for the result.
   *
   * @param action - The action to run.
   * @param args - The action arguments.
   * @returns The action result.
   */
  runAction<Action extends FunctionReference<"action", any>>(
    action: Action,
    args: FunctionArgs<Action>,
  ): Promise<FunctionReturnType<Action>>;

  /**
   * Sleep for a given number of milliseconds. It's totally fine for this to be
   * very long (e.g. on the order of months).
   *
   * @param ms - The number of milliseconds to sleep.
   */
  sleep(ms: number): Promise<void>;
}

export type WorkflowDefinition<ArgsValidator extends PropertyValidators> = {
  args: ArgsValidator;
  handler: (
    step: WorkflowStep,
    args: ObjectType<ArgsValidator>,
  ) => Promise<void>;
};

export type WorkflowStatus =
  | { type: "inProgress" }
  | { type: "completed" }
  | { type: "canceled" }
  | { type: "failed"; error: string };

export class WorkflowManager {
  constructor(private component: UseApi<typeof api>) {}

  /**
   * Define a new workflow.
   *
   * @param workflow - The workflow definition.
   * @returns The workflow mutation.
   */
  define<ArgsValidator extends PropertyValidators>(
    workflow: WorkflowDefinition<ArgsValidator>,
  ): RegisteredMutation<"internal", ObjectType<ArgsValidator>, null> {
    return workflowMutation(this.component, workflow) as any;
  }

  /**
   * Kick off a defined workflow.
   *
   * @param ctx - The Convex context.
   * @param workflow - The workflow to start (e.g. `internal.index.exampleWorkflow`).
   * @param args - The workflow arguments.
   * @returns The workflow ID.
   */
  async start<F extends FunctionReference<"mutation", "internal", any, any>>(
    ctx: GenericMutationCtx<GenericDataModel>,
    workflow: F,
    args: FunctionArgs<F>,
  ): Promise<WorkflowId> {
    const handle = await createFunctionHandle(workflow);
    const workflowId = await ctx.runMutation(
      this.component.index.createWorkflow,
      {
        workflowHandle: handle,
        workflowArgs: args,
      },
    );
    return workflowId as unknown as WorkflowId;
  }

  /**
   * Get a workflow's status.
   *
   * @param ctx - The Convex context.
   * @param workflowId - The workflow ID.
   * @returns The workflow status.
   */
  async status(
    ctx: GenericQueryCtx<GenericDataModel>,
    workflowId: WorkflowId,
  ): Promise<WorkflowStatus> {
    const workflow = await ctx.runQuery(this.component.index.loadWorkflow, {
      workflowId,
    });
    switch (workflow.state.type) {
      case "running":
        return { type: "inProgress" };
      case "canceled":
        return { type: "canceled" };
      case "completed":
        if (workflow.state.outcome.type === "success") {
          return { type: "completed" };
        } else {
          return { type: "failed", error: workflow.state.outcome.error };
        }
    }
  }

  /**
   * Cancel a running workflow.
   *
   * @param ctx - The Convex context.
   * @param workflowId - The workflow ID.
   */
  async cancel(
    ctx: GenericMutationCtx<GenericDataModel>,
    workflowId: WorkflowId,
  ) {
    await ctx.runMutation(this.component.index.cancelWorkflow, {
      workflowId,
    });
  }

  /**
   * Clean up a workflow's storage. The workflow must be completed.
   *
   * @param ctx - The Convex context.
   * @param workflowId - The workflow ID.
   */
  async cleanup(
    ctx: GenericMutationCtx<GenericDataModel>,
    workflowId: WorkflowId,
  ) {
    await ctx.runMutation(this.component.index.cleanupWorkflow, {
      workflowId,
    });
  }
}
