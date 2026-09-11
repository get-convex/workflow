# Developing guide

## Running locally

```sh
npm i
npm run dev
```

## Testing

```sh
npm run clean
npm run build
npm run typecheck
npm run lint
npm run test
```

### Deterministic fault and performance harness

The example suite includes a seeded differential harness that runs identical
generated workflows in mutation-driven and action-driven modes. It injects
query, mutation, and action errors and timeout-shaped failures; retry recovery,
permanent action failure, scheduled handoffs, sleeps, and parallel rounds are
always represented. The oracle checks normalized journals, continuation results,
action attempt counts, exactly-once successful effects, and rollback of
mutations that write before failing.

```sh
npm run test:workflow-harness
WORKFLOW_HARNESS_SEED=123 WORKFLOW_HARNESS_CASES=20 \
  WORKFLOW_HARNESS_OPERATIONS=32 npm run test:workflow-harness
```

Every failure prints a single-seed reproduction command and the generated plan.
Benchmark runs emit one `WORKFLOW_HARNESS_METRICS` JSON record containing
per-mode wall time, deterministic virtual scheduler time, throughput, journal
size, injected failures, and action attempt counts. Wall-clock measurements are
for comparison and trend tracking, not hard pass/fail thresholds.

## Deploying

### Building a one-off package

```sh
npm run clean
npm ci
npm pack
```

### Deploying a new version

```sh
npm run release
```

or for alpha release:

```sh
npm run alpha
```
