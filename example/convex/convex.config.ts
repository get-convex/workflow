import { defineApp } from "convex/server";
import workflow from "@convex-dev/workflow/convex.config";
import staticHosting from "@convex-dev/static-hosting/convex.config.js";

const app = defineApp({ httpPrefix: "/api" });
app.use(workflow);
app.use(staticHosting, { httpPrefix: "/" });
export default app;
