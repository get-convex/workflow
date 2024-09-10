# Convex Workflow (ALPHA)

This component adds durably executed _workflows_ to Convex. Combine Convex queries, mutations,
and actions into long-lived workflows, where the system will always fully execute a workflow
to completion.

```ts
import { WorkflowManager } from "@convex-dev/workflow/component";
import { components } from "./_generated/server";

export const workflow = new WorkflowManager(components.workflow);

export const exampleWorkflow = workflow.define({
  args: {
    storageId: v.id("_storage"),
  },
  handler: async (step, args) => {
    const transcription = await step.runAction(api.index.computeTranscription, {
      storageId: args.storageId,
    });
    const embedding = await step.runAction(api.index.computeEmbedding, {
      transcription,
    });
    console.log(embedding);
  },
});
```

## Installation

First, add `@convex-dev/workflow` to your Convex project:

```
npm install @convex-dev/workflow
```

Then, install the component within your `convex/convex.config.ts` file:

```ts
// convex/convex.config.ts
import workflow from "@convex-dev/workflow/component";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(workflow);
export default app;
```

Finally, create a workflow manager within your `convex/` folder, and point it
to the installed component:

```ts
// convex/index.ts
import { WorkflowManager } from "@convex-dev/workflow/component";
import { components } from "./_generated/server";

export const workflow = new WorkflowManager(components.workflow);
```

## Usage

The first step is to define a workflow using `workflow.define()`. This function
is designed to be reminiscent of defining a Convex action but with a few restrictions:

1. The workflow must declare an argument validator.
2. The workflow runs in the background, so it can't return a value.
3. The workflow must be _deterministic_, so it should implement most of its logic
   by calling out to other Convex functions. We will be lifting some of these
   restrictions over time by implementing `Math.random()`, `Date.now()`, and
   `fetch` within our workflow environment.

```ts
// convex/index.ts

workflow.define({
  args: {
    storageId: v.id("_storage"),
  },
  handler: async (step, args) => {
    const transcription = await step.runAction(api.index.computeTranscription, {
      storageId: args.storageId,
    });
    const embedding = await step.runAction(api.index.computeEmbedding, {
      transcription,
    });
    console.log(embedding);
  },
});
```

Once you've defined a workflow, you can start it using `workflow.start()`, which
will kick off execution of the workflow and return a `WorkflowId`. You can then query 
the status of the workflow with `workflow.status()` or cancel it with `workflow.cancel()`.

```ts
// convex/index.ts

export const workflowExample = mutation(async (ctx) => {
    const workflowId = await workflow.start(ctx, api.index.exampleWorkflow, {
        storageId: ...,
    });
    const status = await workflow.status(ctx, workflowId);
    return status;
});
```

## Limitations

Convex workflows is an alpha product currently under active development. Here are
a few limitations to keep in mind:

- `console.log()` isn't currently captured, so you may see duplicate log lines
  within your Convex dashboard.
- We currently do not collect backtraces from within function calls from workflows.  
- If you need to use side effects like `fetch`, `Math.random()`, or `Date.now()`, 
  you'll need to define a separate Convex action, perform the side effects there,
  and then call that action from the workflow with `step.runAction()`.
- We currently don't do determinism checks, and we don't have explicit bounds on the
  workflow engine's journal size. Workflows that run for a long time or rely on 
  nondeterministic state, like changing environment variables, may behave unpredictably.
