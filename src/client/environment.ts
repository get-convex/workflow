import { FunctionHandle, FunctionReference } from "convex/server";
import { OriginalEnv } from "./step.js";
import { StepContext } from "./stepContext.js";
import { request, response } from "../component/fetch.js";
import { Infer } from "convex/values";

export function setupEnvironment(
  ctx: StepContext,
  fetch: FetchReference,
): OriginalEnv {
  const global = globalThis as any;

  global.Math.random = (...args: any[]) => {
    throw new Error("Math.random() isn't currently supported within workflows");
  };

  const originalDate = global.Date;
  delete global.Date;

  function Date(this: any, ...args: any[]) {
    // `Date()` was called directly, not as a constructor.
    if (!(this instanceof Date)) {
      const date = new (Date as any)();
      return date.toString();
    }
    if (args.length === 0) {
      const unixTsMs = Date.now();
      return new originalDate(unixTsMs);
    }
    return new (originalDate as any)(...args);
  }
  Date.now = function () {
    throw new Error("Date.now() isn't currently supported within workflows.");
  };
  Date.parse = originalDate.parse;
  Date.UTC = originalDate.UTC;
  Date.prototype = originalDate.prototype;
  Date.prototype.constructor = Date;

  global.Date = Date;

  delete global.process;

  delete global.Crypto;
  delete global.crypto;
  delete global.CryptoKey;
  delete global.SubtleCrypto;

  global.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    throw new Error(
      `Fetch isn't currently supported within workflows. Perform the fetch within an action and call it with step.runAction().`,
    );
  };
  return { Date: originalDate };
}

type FetchReference = FunctionReference<
  "action",
  "internal",
  Infer<typeof request>,
  Infer<typeof response>
>;

async function envFetch(
  ctx: StepContext,
  componentFetch: FetchReference,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (input instanceof Request) {
    throw new Error(`TODO: Implement Request handling for envFetch`);
  }
  const method = init?.method || "GET";
  const headers = init?.headers || {};
  let body: ArrayBuffer | undefined;
  if (init?.body) {
    if (typeof init.body === "string") {
      body = new TextEncoder().encode(init.body);
    } else if (init.body instanceof ArrayBuffer) {
      body = init.body;
    } else {
      throw new Error(
        `TODO: Unsupported body type for envFetch: ${typeof init.body}`,
      );
    }
  }
  const resp = await ctx.runAction(componentFetch, {
    url: input.toString(),
    method,
    headers,
    body,
  });
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}
