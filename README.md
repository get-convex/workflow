# Convex Workflow

[![npm version](https://badge.fury.io/js/@convex-dev%2Fworkflow.svg?)](https://badge.fury.io/js/@convex-dev%2Fworkflow)

**Note: Convex Components are currently in beta.**

<!-- START: Include on https://convex.dev/components -->

Have you ever wanted to sleep for 7 days within a Convex function?
Find yourself in callback hell chaining together function calls through queues?
Sick of manual state management and scheduling in long-lived workflows?
Convex workflows might just be what you're looking for.

```ts
import { WorkflowManager } from "@convex-dev/workflow";
import { components } from "./_generated/server";

export const workflow = new WorkflowManager(components.workflow);

export const exampleWorkflow = workflow.define({
  args: {
    storageId: v.id("_storage"),
  },
  handler: async (step, args) => {
    const transcription = await step.runAction(
      internal.index.computeTranscription,
      { storageId: args.storageId },
    );

    // Sleep for a month after computing the transcription.
    await step.sleep(30 * 24 * 60 * 60 * 1000);

    const embedding = await step.runAction(internal.index.computeEmbedding, {
      transcription,
    });
    console.log(embedding);
  },
});
```

This component adds durably executed _workflows_ to Convex. Combine Convex queries, mutations,
and actions into long-lived workflows, and the system will always fully execute a workflow
to completion.

This component is currently in beta and may have some rough edges.
Open a [GitHub issue](https://github.com/get-convex/workflow/issues) with any feedback or bugs you find.

## Installation

First, add `@convex-dev/workflow` to your Convex project:

```sh
npm install @convex-dev/workflow
```

Then, install the component within your `convex/convex.config.ts` file:

```ts
// convex/convex.config.ts
import workflow from "@convex-dev/workflow/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(workflow);
export default app;
```

Finally, create a workflow manager within your `convex/` folder, and point it
to the installed component:

```ts
// convex/index.ts
import { WorkflowManager } from "@convex-dev/workflow";
import { components } from "./_generated/server";

export const workflow = new WorkflowManager(components.workflow);
```

## Usage

The first step is to define a workflow using `workflow.define()`. This function
is designed to feel like a Convex action but with a few restrictions:

1. The workflow runs in the background, so it can't return a value.
2. The workflow must be _deterministic_, so it should implement most of its logic
   by calling out to other Convex functions. We will be lifting some of these
   restrictions over time by implementing `Math.random()`, `Date.now()`, and
   `fetch` within our workflow environment.

```ts
export const exampleWorkflow = workflow.define({
  args: { name: v.string() },
  handler: async (step, args) => {
    const queryResult = await step.runQuery(
      internal.example.exampleQuery,
      args,
    );
    const actionResult = await step.runAction(
      internal.example.exampleAction,
      args,
    );
    console.log(queryResult, actionResult);
  },
});

export const exampleQuery = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    return `The query says... Hi ${args.name}!`;
  },
});

export const exampleAction = internalAction({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    return `The action says... Hi ${args.name}!`;
  },
});
```

Once you've defined a workflow, you can start it from a mutation or action
using `workflow.start()`.

```ts
export const kickoffWorkflow = mutation({
  handler: async (ctx) => {
    const workflowId = await workflow.start(
      ctx,
      internal.example.exampleWorkflow,
      {
        name: "James",
      },
    );
  },
});
```

The `workflow.start()` method returns a `WorkflowId`, which can then be used for querying
a workflow's status.

```ts
export const kickoffWorkflow = action({
  handler: async (ctx) => {
    const workflowId = await workflow.start(
      ctx,
      internal.example.exampleWorkflow,
      {
        name: "James",
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const status = await workflow.status(ctx, workflowId);
    console.log("Workflow status after 1s", status);
  },
});
```

You can also cancel a workflow with `workflow.cancel()`, halting the workflow's execution immmediately. In-progress calls to `step.runAction()`, however, only have best-effort cancelation.

```ts
export const kickoffWorkflow = action({
  handler: async (ctx) => {
    const workflowId = await workflow.start(
      ctx,
      internal.example.exampleWorkflow,
      {
        name: "James",
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Cancel the workflow after 1 second.
    await workflow.cancel(ctx, workflowId);
  },
});
```

After a workflow has completed, you can clean up its storage with `workflow.cleanup()`.
Completed workflows are not automatically cleaned up by the system.

```ts
export const kickoffWorkflow = action({
  handler: async (ctx) => {
    const workflowId = await workflow.start(
      ctx,
      internal.example.exampleWorkflow,
      {
        name: "James",
      },
    );
    try {
      while (true) {
        const status = await workflow.status(ctx, workflowId);
        if (status.type === "inProgress") {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        console.log("Workflow completed with status:", status);
        break;
      }
    } finally {
      await workflow.cleanup(ctx, workflowId);
    }
  },
});
```

## Limitations

Convex workflows is a beta product currently under active development. Here are
a few limitations to keep in mind:

- Steps can only take in and return a total of _1 MiB_ of data within a single
  workflow execution. If you run into journal size limits, you can work around
  this by storing results within your worker functions and then passing IDs
  around within the the workflow.
- `console.log()` isn't currently captured, so you may see duplicate log lines
  within your Convex dashboard.
- We currently do not collect backtraces from within function calls from workflows.
- If you need to use side effects like `fetch`, `Math.random()`, or `Date.now()`,
  you'll need to define a separate Convex action, perform the side effects there,
  and then call that action from the workflow with `step.runAction()`.
- If the implementation of the workflow meaningfully changes (steps added,
  removed, or reordered) then it will fail with a determinism violation.
  The implementation should stay stable for the lifetime of active workflows.

<!-- END: Include on https://convex.dev/components -->
