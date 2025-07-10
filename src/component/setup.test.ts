/// <reference types="vite/client" />
import { test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema.js";
export const modules = import.meta.glob("./**/*.*s");

// set up nested workpool
import componentSchema from "../../node_modules/@convex-dev/workpool/src/component/schema.js";
export { componentSchema };
export const componentModules = import.meta.glob(
  "../../node_modules/@convex-dev/workpool/src/component/**/*.ts",
);
export function initConvexTest() {
  const t = convexTest(schema, modules);
  t.registerComponent("workpool", componentSchema, componentModules);
  return t;
}

test("setup", () => {});
