import { defineApp } from "convex/server";
import workflow from "@convex-dev/workflow/convex.config.js";

const app = defineApp();
app.use(workflow);

export default app;
