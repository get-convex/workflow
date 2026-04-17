If we can get ctx.meta.getFunctionMetadata().name, then we can call the function directly to start it:

- [x] support taking in args directly - no more { fn, args } -> ian/direct-workflow-call
  - [-] assert that their function args don't conflict, and start passing workflowId elsehwere
    - [-] maybe start tracking generations and stop passing workflowId
- [ ] no more .start needed?


Ship defineWorkflow with withHandlerRef?
- ideally we get static args before defineWorkflow becomes default so they can specify logLevel &
   maxParallelism w/o init mutation
