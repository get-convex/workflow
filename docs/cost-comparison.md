# Cost Comparison: Convex Workflows vs AWS Lambda + Step Functions

This document compares the infrastructure cost of running durable LLM workflows on Convex (using the executor model) versus AWS Lambda + Step Functions.

## Workload Profile

| Metric | Value |
|--------|-------|
| Workflows per batch | 10,000 |
| Steps per workflow | 4 (LLM API calls) |
| Total actions per batch | 40,000 |
| Batch duration | ~5 minutes |
| Avg LLM call latency | ~5 seconds |
| Throughput | 8,000 requests/minute |

## Single Batch (10K Workflows)

### Convex (Executor Model)

The executor model batches operations aggressively, minimizing function call overhead:

| Operation | Count | How |
|-----------|-------|-----|
| Task claims | ~27 queries | 40K tasks / 1,500 per claim |
| Result flushes | ~800 mutations | 40K results / 50 per batch |
| Replays | ~800 mutations | Inlined with flush |
| Workflow creation | ~100 mutations | 10K / 100 per batch |
| **Total function calls** | **~2,000** | |

| Cost Component | Calculation | Amount |
|----------------|-------------|--------|
| Function calls | 2K × $2/1M | ~$0.004 |
| Action compute | 40K × 5s × 128MB ≈ 7 GB-hr × $0.30 | ~$2.10 |
| Database bandwidth | Minimal | ~$0.10 |
| **Total** | | **~$2.20** |

### AWS Lambda + Step Functions

| Cost Component | Calculation | Amount |
|----------------|-------------|--------|
| Lambda requests | 40K × $0.20/1M | $0.008 |
| Lambda compute | 40K × 5s × 256MB × $0.0000166667/GB-s | $0.85 |
| Step Functions | 100K state transitions × $0.025/1K | $2.50 |
| **Total** | | **~$3.36** |

## At Scale: Continuous Load (24/7)

Running the above workload every 5 minutes, continuously:

| Metric | Value |
|--------|-------|
| Batches per month | 8,640 |
| Workflows per month | 86.4M |
| LLM calls per month | 345.6M |

### Convex (Executor Model)

| Cost Component | Calculation | Monthly Cost |
|----------------|-------------|-------------|
| Function calls | ~17M × $2/1M | $34 |
| Action compute | 7 GB-hr × 8,640 ≈ 60K GB-hr × $0.30 | $18,000 |
| Database bandwidth | | ~$500 |
| **Total** | | **~$18,500/month** |

### AWS Lambda + Step Functions

| Cost Component | Calculation | Monthly Cost |
|----------------|-------------|-------------|
| Lambda requests | 346M × $0.20/1M | $69 |
| Lambda compute | 60K GB-hr × $0.06/GB-hr | $3,600 |
| Step Functions | 864M transitions × $0.025/1K | $21,600 |
| DynamoDB (state) | Estimated | ~$2,000 |
| Custom orchestration code | Maintenance burden | N/A |
| **Total** | | **~$27,300/month** |

### Summary

| | Convex (Executor) | Lambda + Step Functions |
|-|-------------------|------------------------|
| Monthly cost | ~$18,500 | ~$27,300 |
| Engineering effort | Zero — built-in orchestration | Significant — custom infra code |
| Durable execution | Included | Must build or integrate |
| Observability | Built-in (reactive queries) | Custom (CloudWatch + tooling) |
| Retry/error handling | Built-in | Custom |

## Where the Costs Live

At this workload profile, **action compute dominates** on both platforms. The time spent waiting for LLM API responses is irreducible — no platform can avoid it.

The executor model eliminates the function call overhead that would otherwise dominate Convex costs. Without it, a naive per-task orchestration approach would generate 500K-1M function calls per batch, pushing Convex costs to $100-190K/month — 5-10x more expensive than Lambda.

### Cost breakdown at scale (monthly)

```
Convex (Executor Model)         Lambda + Step Functions
━━━━━━━━━━━━━━━━━━━━━━━        ━━━━━━━━━━━━━━━━━━━━━━━
Action compute   $18,000 (97%)  Lambda compute    $3,600 (13%)
Function calls       $34 (<1%)  Step Functions   $21,600 (79%)
DB bandwidth        $500  (3%)  Lambda requests      $69 (<1%)
                                DynamoDB          $2,000  (7%)
───────────────────────         ───────────────────────
Total            $18,500        Total            $27,300
```

## Context: LLM API Costs Dwarf Infrastructure

At 345.6M Anthropic API calls per month, the API spend likely ranges from **$500K to $2M+/month** depending on model and token volume. Infrastructure costs on either platform represent **1-5%** of total spend.

The decision between platforms is better framed around **engineering velocity and operational burden** than raw infrastructure cost. Convex eliminates the need for dedicated infrastructure engineers to build and maintain the orchestration layer — at $200K+/engineer, even one headcount saved pays for the infrastructure difference many times over.

## Key Takeaway

The executor model makes Convex **cost-competitive with — and often cheaper than** — Lambda + Step Functions for high-throughput durable workflows. The batching strategy (bulk claims, batched result flushes, inlined replays) reduces function call overhead by ~250-500x, shifting the cost profile to be dominated by irreducible action compute time.
