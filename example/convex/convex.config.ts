import { defineApp } from "convex/server";
import workflow from "@convex-dev/workflow/convex.config";
import workpool from "@convex-dev/workpool/convex.config";

const app = defineApp();
app.use(workflow);
app.use(workpool);
export default app;
