import { v } from "convex/values";
import { action } from "./_generated/server.js";

export const request = v.object({
  url: v.string(),
  method: v.string(),
  headers: v.any(), // v.record(v.string(), v.string()),
  body: v.optional(v.bytes()),
});

export const response = v.object({
  status: v.number(),
  statusText: v.string(),
  headers: v.any(), // v.record(v.string(), v.string()),
  body: v.bytes(),
});

export const executeFetch = action({
  args: request,
  returns: response,
  handler: async (_, args) => {
    const response = await fetch(args.url, {
      method: args.method,
      headers: args.headers,
      body: args.body,
    });
    const body = await response.arrayBuffer();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
    };
  },
});
