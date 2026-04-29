import { v } from "convex/values";
import { OpenAI } from "openai";
import { internal } from "./_generated/api.js";
import { internalAction } from "./_generated/server.js";
import { workflow } from "./example.js";

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is not configured.\n" +
        "npx convex env set OPENAI_API_KEY sk-****",
    );
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

export const transcriptionWorkflow = workflow
  .define({
    args: {
      storageId: v.id("_storage"),
    },
  })
  .handler(async (step, args) => {
    const transcription = await step.runAction(
      internal.transcription.computeTranscription,
      {
        storageId: args.storageId,
      },
    );
    console.log(transcription);
    const embedding = await step.runAction(
      internal.transcription.computeEmbedding,
      { transcription },
      { retry: false },
    );
    console.log(embedding.slice(0, 20));
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
    const file = new File([blob], `${args.storageId}`, {
      type: blob.type,
    });
    const transcription = await getOpenAI().audio.transcriptions.create({
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
    const embeddingResponse = await getOpenAI().embeddings.create({
      input: [args.transcription],
      model: "text-embedding-3-small",
    });
    const embedding = embeddingResponse.data[0].embedding;
    return embedding;
  },
});
