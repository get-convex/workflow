import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import workpool from "@convex-dev/workpool/test";
import schema from "./component/schema.js";
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the component with the test convex instance.
 * @param t - The test convex instance, e.g. from calling `convexTest`.
 * @param name - The name of the component, as registered in convex.config.ts.
 */
function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "workflow",
) {
  t.registerComponent(name, schema, modules);
  workpool.register(t, `${name}/workpool`);
}
export default { register, schema, modules };
