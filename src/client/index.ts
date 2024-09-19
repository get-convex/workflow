import {
  createFunctionHandle,
  FunctionArgs,
  FunctionReference,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  RegisteredMutation,
} from "convex/server";
import { ObjectType, PropertyValidators } from "convex/values";
import { api } from "../component/_generated/api.js";
import { UseApi, WorkflowId } from "../types.js";
import { workflowMutation } from "./workflowMutation.js";
import { LogLevel } from "../component/schema.js";

export type { WorkflowId };

type ActionCtxRunners = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;

export type WorkflowStep = ActionCtxRunners & {
  /**
   * Sleep for a given number of milliseconds. It's totally fine for this to be
   * very long (e.g. on the order of months).
   *
   * @param ms - The number of milliseconds to sleep.
   */
  sleep(ms: number): Promise<void>;
};

export type WorkflowDefinition<ArgsValidator extends PropertyValidators> = {
  args?: ArgsValidator;
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

export type Options = {
  logLevel?: LogLevel;
};

export class WorkflowManager {
  logLevel: LogLevel;

  constructor(
    private component: UseApi<typeof api>,
    options?: Options,
  ) {
    let DEFAULT_LOG_LEVEL: LogLevel = "INFO";
    if (process.env.WORKFLOW_LOG_LEVEL) {
      if (
        !["DEBUG", "INFO", "WARN", "ERROR"].includes(
          process.env.WORKFLOW_LOG_LEVEL,
        )
      ) {
        console.warn(
          `Invalid log level (${process.env.WORKFLOW_LOG_LEVEL}), defaulting to "INFO"`,
        );
      }
      DEFAULT_LOG_LEVEL = process.env.WORKFLOW_LOG_LEVEL as LogLevel;
    }
    this.logLevel = options?.logLevel ?? DEFAULT_LOG_LEVEL;
  }

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
    ctx: RunMutationCtx,
    workflow: F,
    args: FunctionArgs<F>,
  ): Promise<WorkflowId> {
    const handle = await createFunctionHandle(workflow);
    const workflowId = await ctx.runMutation(this.component.workflow.create, {
      workflowHandle: handle,
      workflowArgs: args,
      logLevel: this.logLevel,
    });
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
    ctx: RunQueryCtx,
    workflowId: WorkflowId,
  ): Promise<WorkflowStatus> {
    const workflow = await ctx.runQuery(this.component.workflow.load, {
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
  async cancel(ctx: RunMutationCtx, workflowId: WorkflowId) {
    await ctx.runMutation(this.component.workflow.cancel, {
      workflowId,
    });
  }

  /**
   * Clean up a workflow's storage. The workflow must be completed.
   *
   * @param ctx - The Convex context.
   * @param workflowId - The workflow ID.
   */
  async cleanup(ctx: RunMutationCtx, workflowId: WorkflowId) {
    await ctx.runMutation(this.component.workflow.cleanup, {
      workflowId,
    });
  }
}

type RunQueryCtx = {
  runQuery: GenericQueryCtx<GenericDataModel>["runQuery"];
};
type RunMutationCtx = {
  runMutation: GenericMutationCtx<GenericDataModel>["runMutation"];
};
