import {
  createFunctionHandle,
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  GenericDataModel,
  GenericMutationCtx,
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

export type WorkflowDefinition<
  ArgsValidator extends PropertyValidators,
  ReturnsValidator extends Validator<any, any, any>,
> = {
  args: ArgsValidator;
  returns: ReturnsValidator;
  handler: (
    step: WorkflowStep,
    args: ObjectType<ArgsValidator>,
  ) => ReturnValueForOptionalValidator<ReturnsValidator>;
};

export class WorkflowManager {
  constructor(private component: UseApi<typeof api>) {}

  define<
    ArgsValidator extends PropertyValidators,
    ReturnsValidator extends Validator<any, any, any>,
  >(
    workflow: WorkflowDefinition<ArgsValidator, ReturnsValidator>,
  ): RegisteredMutation<
    "public",
    ObjectType<ArgsValidator>,
    ReturnValueForOptionalValidator<ReturnsValidator>
  > {
    return workflowMutation(this.component, workflow) as any;
  }

  async start<F extends FunctionReference<"mutation", any>>(
    ctx: GenericMutationCtx<GenericDataModel>,
    workflow: F,
    args: FunctionArgs<F>,
  ): Promise<WorkflowId<FunctionReturnType<F>>> {
    const handle = await createFunctionHandle(workflow);
    const workflowId = await ctx.runMutation(
      this.component.index.createWorkflow,
      {
        workflowHandle: handle,
        workflowArgs: args,
      },
    );
    return workflowId as unknown as WorkflowId<FunctionReturnType<F>>;
  }
}
