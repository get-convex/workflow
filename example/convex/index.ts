import { v } from "convex/values";
import { WorkflowManager, } from "../../src/client"
import { api } from "./_generated/api.js"
import { action, components, mutation } from "./_generated/server"
import { Id } from "./_generated/dataModel";

const workflow = new WorkflowManager(components.workflow);

export const exampleWorkflow = workflow.define({
    args: {
        storageId: v.id("_storage"),
    },
    returns: v.null(),
    handler: async (step, args) => {
        const transcription = await step.runAction(
            api.index.computeTranscription,
            {
                storageId: args.storageId,
            },
        );
        console.log('before sleep');
        await step.sleep(500);
        console.log('after sleep');
        const embedding = await step.runAction(api.index.computeEmbedding, {
            transcription,
        });
        console.log("embedding done", embedding);
    },
})

export const kickoffWorkflow = mutation({
    handler: async (ctx) => {
        const storageId = "kg2c4mhdc0xvt772gzyk26g1856yayky" as Id<"_storage">;
        await workflow.start(ctx, api.index.exampleWorkflow, { storageId });
    },
});

export const computeTranscription = action({
    args: {
        storageId: v.id("_storage"),
    },
    returns: v.string(),
    handler: async (ctx, args) => {
        return "transcription";
    },
});

export const computeEmbedding = action({
    args: {
        transcription: v.string(),
    },
    returns: v.string(),
    handler: async (ctx, args) => {
        return "embedding";
    },
});
