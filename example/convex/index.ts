import { v } from "convex/values";
import { WorkflowManager } from "../../src/client";
import { internal } from "./_generated/api.js";
import { components, internalAction } from "./_generated/server";
import { OpenAI } from "openai";

export const workflow = new WorkflowManager(components.workflow);

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is not configured.");
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const exampleWorkflow = workflow.define({
  args: {
    storageId: v.id("_storage"),
  },
  handler: async (step, args) => {
    const transcription = await step.runAction(
      internal.index.computeTranscription,
      {
        storageId: args.storageId,
      },
    );
    const embedding = await step.runAction(internal.index.computeEmbedding, {
      transcription,
    });
    console.log(embedding);
  },
});

export const computeTranscription = internalAction({
  args: {
    storageId: v.id("_storage"),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    const blob = await ctx.storage.get(args.storageId);
    if (!blob) {
      throw new Error(`Invalid storage ID: ${args.storageId}`);
    }
    const file = new File([blob], `${args.storageId}.mp3`, {
      type: "audio/mpeg",
    });
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: "whisper-1",
    });
    return transcription.text;
  },
});

export const computeEmbedding = internalAction({
  args: {
    transcription: v.string(),
  },
  returns: v.array(v.number()),
  handler: async (ctx, args) => {
    const embeddingResponse = await openai.embeddings.create({
      input: [args.transcription],
      model: "text-embedding-3-small",
    });
    const embedding = embeddingResponse.data[0].embedding;
    return embedding;
  },
});
