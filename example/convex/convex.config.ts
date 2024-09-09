import { defineApp } from "convex/server";
import workflow from "../../src/component/convex.config";

const app = defineApp();
app.use(workflow, { name: "workflow" });

export default app;
