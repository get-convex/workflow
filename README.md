# Convex Durable Workflows

[![npm version](https://badge.fury.io/js/@convex-dev%2Fworkflow.svg?)](https://badge.fury.io/js/@convex-dev%2Fworkflow)

<!-- START: Include on https://convex.dev/components -->

Have you ever wanted to run a series of functions reliably and durably, where
each can have its own retry behavior, the overall workflow will survive server
restarts, and you can have long-running workflows spanning months that can be
canceled? Do you want to observe the status of a workflow reactively, as well as
the results written from each step?

And do you want to do this with code, instead of a static configuration?

Welcome to the world of Convex workflows.

- Run workflows asynchronously, and observe their status reactively via
  subscriptions, from one or many users simultaneously, even on page refreshes.
- Workflows can run for months, and survive server restarts. You can specify
  delays or custom times to run each step.
- Run steps in parallel, or in sequence.
- Output from previous steps is available to pass to subsequent steps.
- Run queries, mutations, and actions.
- Specify retry behavior on a per-step basis, along with a default policy.
- Specify how many workflow steps can run in parallel to manage load.
- Cancel long-running workflows.
- Clean up workflows after they're done.

```ts
import { WorkflowManager } from "@convex-dev/workflow";
import { components } from "./_generated/api";

export const workflow = new WorkflowManager(components.workflow);

export const userOnboarding = workflow.define({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args): Promise<void> => {
    const status = await ctx.runMutation(
      internal.emails.sendVerificationEmail,
      { storageId: args.storageId },
    );

    if (status === "needsVerification") {
      // Waits until verification is completed asynchronously.
      await ctx.awaitEvent({ name: "verificationEmail" });
    }
    const result = await ctx.runAction(
      internal.llm.generateCustomContent,
      { userId: args.userId },
      // Retry this on transient errors with the default retry policy.
      { retry: true },
    );
    if (result.needsHumanInput) {
      // Run a whole workflow as a single step.
      await ctx.runWorkflow(internal.llm.refineContentWorkflow, {
        userId: args.userId,
      });
    }

    await ctx.runMutation(
      internal.emails.sendFollowUpEmailMaybe,
      { userId: args.userId },
      // Runs one day after the previous step.
      { runAfter: 24 * 60 * 60 * 1000 },
    );
  },
});
```

This component adds durably executed _workflows_ to Convex. Combine Convex
queries, mutations, and actions into long-lived workflows, and the system will
always fully execute a workflow to completion.

Open a [GitHub issue](https://github.com/get-convex/workflow/issues) with any
feedback or bugs you find.

## Installation

First, add `@convex-dev/workflow` to your Convex project:

```sh
npm install @convex-dev/workflow
```

Then, install the component within your `convex/convex.config.ts` file:

```ts
// convex/convex.config.ts
import workflow from "@convex-dev/workflow/convex.config.js";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(workflow);
export default app;
```

Finally, create a workflow manager within your `convex/` folder, and point it to
the installed component:

```ts
// convex/index.ts
import { WorkflowManager } from "@convex-dev/workflow";
import { components } from "./_generated/api";

export const workflow = new WorkflowManager(components.workflow);
```

## Usage

The first step is to define a workflow using `workflow.define()`. This function
is designed to feel like a Convex action but with a few restrictions:

1. The workflow runs in the background, so it can't return a value.
2. The workflow must be _deterministic_, so it should implement most of its
   logic by calling out to other Convex functions. We restrict access to some
   non-deterministic functions like `fetch` and `crypto`. Others we patch, such
   as `console` for logging, `Math.random()` (seeded PRNG) and `Date` for time.

Note: To help avoid type cycles, always annotate the return type of the
`handler` with the return type of the workflow.

```ts
export const exampleWorkflow = workflow.define({
  args: { name: v.string() },
  returns: v.string(),
  handler: async (step, args): Promise<string> => {
    //                         ^ Specify the return type of the handler
    const queryResult = await step.runQuery(
      internal.example.exampleQuery,
      args,
    );
    const actionResult = await step.runAction(
      internal.example.exampleAction,
      { queryResult }, // pass in results from previous steps!
    );
    return actionResult;
  },
});

export const exampleQuery = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    return `The query says... Hi ${args.name}!`;
  },
});

export const exampleAction = internalAction({
  args: { queryResult: v.string() },
  handler: async (ctx, args) => {
    return args.queryResult + " The action says... Hi back!";
  },
});
```

### Starting a workflow

Once you've defined a workflow, you can start it from a mutation or action using
`workflow.start()`.

```ts
export const kickoffWorkflow = mutation({
  handler: async (ctx) => {
    const workflowId = await workflow.start(
      ctx,
      internal.example.exampleWorkflow,
      { name: "James" },
    );
  },
});
```

### Handling the workflow's result with onComplete

You can handle the workflow's result with `onComplete`. This is useful for
cleaning up any resources used by the workflow.

Note: when you return things from a workflow, you'll need to specify the return
type of your `handler` to break type cycles due to using `internal.*` functions
in the body, which then inform the type of the workflow, which is included in
the `internal.*` type.

You can also specify a `returns` validator to do runtime validation on the
return value. If it fails, your `onComplete` handler will be called with an
error instead of success. You can also do validation in the `onComplete` handler
to have more control over handling that situation.

```ts
import { vWorkflowId } from "@convex-dev/workflow";
import { vResultValidator } from "@convex-dev/workpool";

export const foo = mutation({
  handler: async (ctx) => {
    const name = "James";
    const workflowId = await workflow.start(
      ctx,
      internal.example.exampleWorkflow,
      { name },
      {
        onComplete: internal.example.handleOnComplete,
        context: name, // can be anything
      },
    );
  },
});

export const handleOnComplete = mutation({
  args: {
    workflowId: vWorkflowId,
    result: vResultValidator,
    context: v.any(), // used to pass through data from the start site.
  },
  handler: async (ctx, args) => {
    const name = (args.context as { name: string }).name;
    if (args.result.kind === "success") {
      const text = args.result.returnValue;
      console.log(`${name} result: ${text}`);
    } else if (args.result.kind === "error") {
      console.error("Workflow failed", args.result.error);
    } else if (args.result.kind === "canceled") {
      console.log("Workflow canceled", args.context);
    }
  },
});
```

### Running steps in parallel

You can run steps in parallel by calling `step.runAction()` multiple times in a
`Promise.all()` call.

```ts
export const exampleWorkflow = workflow.define({
  args: { name: v.string() },
  handler: async (step, args): Promise<void> => {
    const [result1, result2] = await Promise.all([
      step.runAction(internal.example.myAction, args),
      step.runAction(internal.example.myAction, args),
    ]);
  },
});
```

Note: The workflow will not proceed until all steps fired off at once have
completed.

### Specifying retry behavior

Sometimes actions fail due to transient errors, whether it was an unreliable
third-party API or a server restart. You can have the workflow automatically
retry actions using best practices (exponential backoff & jitter). By default
there are no retries, and the workflow will fail.

You can specify default retry behavior for all workflows on the WorkflowManager,
or override it on a per-workflow basis.

You can also specify a custom retry behavior per-step, to opt-out of retries for
actions that may want at-most-once semantics.

Workpool options:

If you specify any of these, it will override the
[`DEFAULT_RETRY_BEHAVIOR`](./src/component/pool.ts).

- `defaultRetryBehavior`: The default retry behavior for all workflows.
  - `maxAttempts`: The maximum number of attempts to retry an action.
  - `initialBackoffMs`: The initial backoff time in milliseconds.
  - `base`: The base multiplier for the backoff. Default is 2.
- `retryActionsByDefault`: Whether to retry actions, by default is false.
  - If you specify a retry behavior at the step level, it will always retry.

At the step level, you can also specify `true` or `false` to disable or use the
default policy.

```ts
const workflow = new WorkflowManager(components.workflow, {
  workpoolOptions: {
    defaultRetryBehavior: {
      maxAttempts: 3,
      initialBackoffMs: 100,
      base: 2,
    },
    retryActionsByDefault: true, // default is false
   }
});

export const exampleWorkflow = workflow.define({
  args: { name: v.string() },
  handler: async (step, args): Promise<void> => {
    // Uses default retry behavior & retryActionsByDefault
    await step.runAction(internal.example.myAction, args);
    // Retries will be attempted with the default behavior
    await step.runAction(internal.example.myAction, args, { retry: true });
    // No retries will be attempted
    await step.runAction(internal.example.myAction, args, { retry: false });
    // Custom retry behavior will be used
    await step.runAction(internal.example.myAction, args, {
      retry: { maxAttempts: 2, initialBackoffMs: 100, base: 2 },
    });
  },
  // If specified, this will override the workflow manager's default
  workpoolOptions: { ... },
});
```

### Specifying step parallelism

You can specify how many steps can run in parallel by setting the
`maxParallelism` workpool option. It has a reasonable default. On the free tier,
you should not exceed 20, otherwise your other scheduled functions may become
delayed while competing for available functions with your workflow steps. On a
Pro account, you should not exceed 100 across all your workflows and workpools.
If you want to do a lot of work in parallel, you should employ batching, where
each workflow operates on a batch of work, e.g. scraping a list of links instead
of one link per workflow.

```ts
const workflow = new WorkflowManager(components.workflow, {
  workpoolOptions: {
    // You must only set this to one value per components.xyz!
    // You can set different values if you "use" multiple different components
    // in convex.config.ts.
    maxParallelism: 10,
  },
});
```

### Checking a workflow's status

The `workflow.start()` method returns a `WorkflowId`, which can then be used for
querying a workflow's status.

```ts
export const kickoffWorkflow = action({
  handler: async (ctx) => {
    const workflowId = await workflow.start(
      ctx,
      internal.example.exampleWorkflow,
      { name: "James" },
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const status = await workflow.status(ctx, workflowId);
    console.log("Workflow status after 1s", status);
  },
});
```

### Canceling a workflow

You can cancel a workflow with `workflow.cancel()`, halting the workflow's
execution immmediately. In-progress calls to `step.runAction()`, however, will
finish executing.

```ts
export const kickoffWorkflow = action({
  handler: async (ctx) => {
    const workflowId = await workflow.start(
      ctx,
      internal.example.exampleWorkflow,
      { name: "James" },
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Cancel the workflow after 1 second.
    await workflow.cancel(ctx, workflowId);
  },
});
```

### Cleaning up a workflow

After a workflow has completed, you can clean up its storage with
`workflow.cleanup()`. Completed workflows are not automatically cleaned up by
the system.

```ts
export const kickoffWorkflow = action({
  handler: async (ctx) => {
    const workflowId = await workflow.start(
      ctx,
      internal.example.exampleWorkflow,
      { name: "James" },
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

### Specifying a custom name for a step

You can specify a custom name for a step by passing a `name` option to the step.

This allows the events emitted to your logs to be more descriptive. By default
it uses the `file/folder:function` name.

```ts
export const exampleWorkflow = workflow.define({
  args: { name: v.string() },
  handler: async (step, args): Promise<void> => {
    await step.runAction(internal.example.myAction, args, { name: "FOO" });
  },
});
```

### Waiting for external events

Use `ctx.awaitEvent` inside a workflow handler to pause until an external event
is triggered. This is useful for human-in-the-loop flows or coordinating with
other asynchronous flows. Wait for an indefinite amount of time and continue
when the event is triggered.

At its simplest, you can wait for an event **by name**:

```ts
await ctx.awaitEvent({ name: "eventName" });
```

This will wait for the first un-consumed event with the name "eventName", and
will continue immediately if one was already sent. Events are sent by calling
`workflow.sendEvent` from a mutation or action:

```ts
await workflow.sendEvent(ctx, {
  name: "eventName",
  workflowId,
});
```

Note: You must send the event on the same workflow component that is waiting for
it, and the workflowId must match the ID of the workflow that is waiting for it.

#### Sending values or errors with the event

You can send a value with the event using the `value` property. For type safety
and runtime validation, provide a validator on the sending and receiving sides.

```ts
const sharedValidator = v.number();

// In the workflow:
const event = await ctx.awaitEvent({ name, validator: sharedValidator });

// From elsewhere:
await workflow.sendEvent(ctx, { name, workflowId, value: 42 });
```

To send an error, use the `error` property. This will cause `ctx.awaitEvent` to
throw an error.

```ts
await workflow.sendEvent(ctx, { name, workflowId, error: "An error occurred" });
```

#### Sharing event definitions

Use `defineEvent` to define an event's name and validator in one place, then
share it between the workflow and the sender:

```ts
const approvalEvent = defineEvent({
  name: "approval",
  validator: v.object({ approved: v.boolean() }),
});

// In the workflow:
const approval = await ctx.awaitEvent(approvalEvent);

// From a mutation:
const value = { approved: true };
await workflow.sendEvent(ctx, { ...approvalEvent, workflowId, value });
```

See [`example/convex/userConfirmation.ts`](./example/convex/userConfirmation.ts)
for a full approval flow built this way.

Note: this is just a convenience to create a typed { event, validator } pair.

#### Waiting for dynamically created events by ID

You can also dynamically create an event with `createEvent`:

```ts
const eventId = await workflow.createEvent(ctx, {
  name: "userResponse",
  workflowId,
});
```

Then wait for it by ID in the workflow:

```ts
await ctx.awaitEvent({ id: eventId });
```

This works well when there are dynamically defined events, for instance a tool
that is waiting for a response from a user. You would save the eventId somewhere
to be able to send the event later with `workflow.sendEvent`:

```ts
await workflow.sendEvent(ctx, { id: eventId });
```

Similar to named events, you can also send a value or error with the event.

See [`example/convex/passingSignals.ts`](./example/convex/passingSignals.ts) for
a complete example of creating events, passing their IDs around, and sending
signals.

### Running nested workflows with `ctx.runWorkflow`

Use `ctx.runWorkflow` to run another workflow as a single step in the current
one. The parent workflow waits for the nested workflow to finish and receives
its return value:
`const result = await ctx.runWorkflow(internal.example.childWorkflow, { args });`

You can also specify scheduling options like `{ runAfter: 5000 }` to delay the
nested workflow. See
[`example/convex/nestedWorkflow.ts`](./example/convex/nestedWorkflow.ts) for a
complete parent/child workflow example.

To associate the child workflow with the parent in your own tables, you can pass
the `ctx.workflowId` to the child workflow as an argument, and/or return the
child's workflowId to the parent.

The status of the parent workflow will include any active child workflowIds.

## Tips and troubleshooting

### Circular dependencies

Having the return value of workflows depend on other Convex functions can lead
to circular dependencies due to the `internal.foo.bar` way of specifying
functions. The way to fix this is to explicitly type the return value of the
workflow. When in doubt, add return types to more `handler` functions, like
this:

```diff
 export const supportAgentWorkflow = workflow.define({
   args: { prompt: v.string(), userId: v.string(), threadId: v.string() },
+  handler: async (step, { prompt, userId, threadId }): Promise<string> => {
     // ...
   },
 });

 // And regular functions too:
 export const myFunction = action({
   args: { prompt: v.string() },
+  handler: async (ctx, { prompt }): Promise<string> => {
     // ...
   },
 });
```

### More concise workflows

To avoid the noise of `internal.foo.*` syntax, you can use a variable. For
instance, if you define all your steps in `convex/steps.ts`, you can do this:

```diff
 const s = internal.steps;

 export const myWorkflow = workflow.define({
   args: { prompt: v.string() },
   handler: async (step, args): Promise<string> => {
+    const result = await step.runAction(s.myAction, args);
     return result;
   },
 });
```

## Limitations

Here are a few limitations to keep in mind:

- Steps can only take in and return a total of _1 MiB_ of data within a single
  workflow execution. If you run into journal size limits, you can work around
  this by storing results in the DB from your step functions and passing IDs
  around within the the workflow.
- The workflow body is internally a mutation, with each step's return value read
  from the database on each subsequent step. As a result, the limits for a
  mutation apply and limit the number and size of steps you can perform
  (including the workflow state overhead). There is currently an 8MiB limit
  imposed on the journal size, to stay well within the mutation bounds. See more
  about mutation limits here:
  https://docs.convex.dev/production/state/limits#transactions
- We currently do not collect backtraces from within function calls from
  workflows.
- If you need to use side effects like `fetch` or use cryptographic randomness,
  you'll need to do that in a step, not in the workflow definition.
- `Math.random` is deterministic and not suitable for cryptographic use. It is,
  however, useful for sharding, jitter, and other pseudo-random applications.
- If the implementation of the workflow meaningfully changes (steps added,
  removed, or reordered) then it will fail with a determinism violation. The
  implementation should stay stable for the lifetime of active workflows. See
  [this issue](https://github.com/get-convex/workflow/issues/35) for ideas on
  how to make this better.

<!-- END: Include on https://convex.dev/components -->
