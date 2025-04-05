/// <reference types="vite/client" />
import { test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
export const modules = import.meta.glob("./**/*.*s");

// Sorry about everything
import componentSchema from "../node_modules/@convex-dev/workflow/src/component/schema";
export { componentSchema };
export const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/workflow/src/component/**/*.ts",
);

export function initConvexTest() {
  const t = convexTest(schema, modules);
  t.registerComponent("bigPool", componentSchema, componentModules);
  t.registerComponent("smallPool", componentSchema, componentModules);
  return t;
}

test("setup", () => {});
