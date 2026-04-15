import { type Value, convexToJson, getConvexSize } from "convex/values";
import type { RunResult } from "@convex-dev/workpool";
import type { MutationCtx } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";

export const MAX_RETURN_VALUE_SIZE = 800 << 10; // 800 KiB
const PREVIEW_SIZE = 128 << 10; // 128 KB

function truncatedPreview(returnValue: unknown): string {
  const json = JSON.stringify(convexToJson(returnValue as Value));
  if (json.length <= PREVIEW_SIZE * 2) {
    return json;
  }
  return json.slice(0, PREVIEW_SIZE) + "..." + json.slice(-PREVIEW_SIZE);
}

export function checkReturnValueSize(returnValue: unknown): string | null {
  const size = getConvexSize(returnValue as Value | undefined);
  if (size > MAX_RETURN_VALUE_SIZE) {
    return `Step return value too large (${size} bytes). Maximum is ${MAX_RETURN_VALUE_SIZE} bytes. Preview: ${truncatedPreview(returnValue)}`;
  }
  return null;
}

export async function checkForOversizedResult(
  _ctx: MutationCtx,
  result: RunResult,
  _opts: {
    stepId: Id<"steps">;
  },
): Promise<RunResult> {
  if (result.kind !== "success") {
    return result;
  }
  const sizeError = checkReturnValueSize(result.returnValue);
  if (!sizeError) {
    return result;
  }
  return { kind: "failed", error: sizeError };
}
