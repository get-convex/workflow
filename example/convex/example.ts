import { v } from "convex/values";
import { WorkflowManager } from "@convex-dev/workflow";
import { internal } from "./_generated/api.js";
import { internalAction, internalMutation } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { OpenAI } from "openai";

export const workflow = new WorkflowManager(components.workflow, {
  workpoolOptions: {
    maxParallelism: 1,
  },
});
