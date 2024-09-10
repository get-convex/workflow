import {
  createFunctionHandle,
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  RegisteredMutation,
  ReturnValueForOptionalValidator,
} from "convex/server";
import { ObjectType, PropertyValidators, Validator } from "convex/values";
import { api } from "../component/_generated/api.js";
import { UseApi, WorkflowId } from "../types.js";
import { workflowMutation } from "./workflowMutation.js";

export interface WorkflowStep {
  runQuery<Query extends FunctionReference<"query", any>>(
    query: Query,
    args: FunctionArgs<Query>,
  ): Promise<FunctionReturnType<Query>>;

  runMutation<Mutation extends FunctionReference<"mutation", any>>(
    mutation: Mutation,
    args: FunctionArgs<Mutation>,
  ): Promise<FunctionReturnType<Mutation>>;

  runAction<Action extends FunctionReference<"action", any>>(
    action: Action,
    args: FunctionArgs<Action>,
  ): Promise<FunctionReturnType<Action>>;

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

  define<ArgsValidator extends PropertyValidators>(
    workflow: WorkflowDefinition<ArgsValidator>,
  ): RegisteredMutation<"internal", ObjectType<ArgsValidator>, null> {
    return workflowMutation(this.component, workflow) as any;
  }

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

  async cancel(
    ctx: GenericMutationCtx<GenericDataModel>,
    workflowId: WorkflowId,
  ) {
    await ctx.runMutation(this.component.index.cancelWorkflow, {
      workflowId,
    });
  }
}
