import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api.js";

type StepSnapshot = {
  stepId: string;
  name: string;
  startedAt: number;
  completedAt: number | null;
  resultKind: "success" | "failed" | "canceled" | null;
};

type WorkflowSnapshot = {
  workflowId: string;
  status: {
    type: "inProgress" | "completed" | "failed" | "canceled";
    error?: string;
  };
  completedAt: number | null;
  steps: StepSnapshot[];
};

type Comparison = {
  comparisonId: string;
  stepCount: number;
  startedAt: number;
  traditional: WorkflowSnapshot;
  action: WorkflowSnapshot;
};

export function App() {
  const [stepCount, setStepCount] = useState(12);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startComparison = useMutation(api.workflowDemo.startComparison);
  const comparison = useQuery(api.workflowDemo.latestComparison, {}) as
    | Comparison
    | null
    | undefined;
  const running =
    comparison?.traditional.status.type === "inProgress" ||
    comparison?.action.status.type === "inProgress";
  const now = useLiveClock(Boolean(running));

  const handleStart = async () => {
    setStarting(true);
    setError(null);
    try {
      await startComparison({ stepCount });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setStarting(false);
    }
  };

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Workflow Relay home">
          <RelayMark />
          <span>Workflow Relay</span>
        </a>
        <div className="live-chip">
          <span className={running ? "live-dot active" : "live-dot"} />
          {running ? "Execution live" : "Ready to compare"}
        </div>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow">Convex workflow execution lab</div>
        <h1>
          Same work.
          <br />
          <span>Two execution paths.</span>
        </h1>
        <p className="hero-copy">
          Run identical query, mutation, and action steps. Watch the traditional
          workpool loop race the continuous action runner in real time.
        </p>

        <div className="control-deck">
          <div className="step-control">
            <div>
              <label htmlFor="step-count">Workflow length</label>
              <span>Mixed query · mutation · action</span>
            </div>
            <output htmlFor="step-count">{stepCount} steps</output>
            <input
              id="step-count"
              type="range"
              min="6"
              max="18"
              step="3"
              value={stepCount}
              onChange={(event) => setStepCount(Number(event.target.value))}
              disabled={starting}
            />
          </div>
          <button
            className="run-button"
            type="button"
            onClick={handleStart}
            disabled={starting}
          >
            <PlayIcon />
            {starting
              ? "Starting…"
              : running
                ? "Run another"
                : "Run comparison"}
          </button>
        </div>
        {error ? <div className="error-banner">{error}</div> : null}
      </section>

      <section className="comparison-section" aria-live="polite">
        {comparison === undefined ? (
          <LoadingState />
        ) : comparison === null ? (
          <EmptyState onStart={handleStart} />
        ) : (
          <ComparisonView comparison={comparison} now={now} />
        )}
      </section>

      <footer>
        <span>Built on durable Convex workflows</span>
        <span className="footer-rule" />
        <span>Reactive from first step to final result</span>
      </footer>
    </main>
  );
}

function ComparisonView({
  comparison,
  now,
}: {
  comparison: Comparison;
  now: number;
}) {
  const traditionalMs = elapsed(
    comparison.traditional,
    comparison.startedAt,
    now,
  );
  const actionMs = elapsed(comparison.action, comparison.startedAt, now);
  const bothDone =
    comparison.traditional.status.type === "completed" &&
    comparison.action.status.type === "completed";
  const speedup = bothDone && actionMs > 0 ? traditionalMs / actionMs : null;

  return (
    <>
      <div className="comparison-heading">
        <div>
          <span className="section-kicker">Latest run</span>
          <h2>{comparison.stepCount}-step execution trace</h2>
        </div>
        {speedup ? (
          <div className="speedup-callout">
            <span>Action runner</span>
            <strong>{speedup.toFixed(1)}× faster</strong>
          </div>
        ) : (
          <div className="race-callout">
            <span className="live-dot active" />
            Comparing live
          </div>
        )}
      </div>

      <div className="workflow-grid">
        <WorkflowCard
          variant="traditional"
          eyebrow="Mutation-driven"
          title="Workpool loop"
          description="Every step returns to the scheduler before the handler can replay."
          snapshot={comparison.traditional}
          totalSteps={comparison.stepCount}
          startedAt={comparison.startedAt}
          now={now}
        />
        <WorkflowCard
          variant="action"
          eyebrow="Action-driven"
          title="Continuous runner"
          description="One action executes simple steps directly, replaying the handler in place."
          snapshot={comparison.action}
          totalSteps={comparison.stepCount}
          startedAt={comparison.startedAt}
          now={now}
        />
      </div>
    </>
  );
}

function WorkflowCard({
  variant,
  eyebrow,
  title,
  description,
  snapshot,
  totalSteps,
  startedAt,
  now,
}: {
  variant: "traditional" | "action";
  eyebrow: string;
  title: string;
  description: string;
  snapshot: WorkflowSnapshot;
  totalSteps: number;
  startedAt: number;
  now: number;
}) {
  const completedSteps = snapshot.steps.filter(
    (step) => step.completedAt !== null,
  ).length;
  const elapsedMs = elapsed(snapshot, startedAt, now);
  const progress = Math.min(100, (completedSteps / totalSteps) * 100);

  return (
    <article className={`workflow-card ${variant}`}>
      <div className="card-accent" />
      <div className="card-header">
        <div>
          <span className="card-eyebrow">{eyebrow}</span>
          <h3>{title}</h3>
        </div>
        <StatusBadge status={snapshot.status.type} />
      </div>
      <p className="card-description">{description}</p>

      <div className="metric-row">
        <div className="metric">
          <span>Elapsed</span>
          <strong>{formatDuration(elapsedMs)}</strong>
        </div>
        <div className="metric">
          <span>Progress</span>
          <strong>
            {completedSteps}/{totalSteps}
          </strong>
        </div>
        <div className="metric path-metric">
          <span>Step routing</span>
          <strong>{variant === "action" ? "Direct" : "Workpool"}</strong>
        </div>
      </div>

      <div className="progress-track" aria-label={`${progress}% complete`}>
        <span style={{ width: `${progress}%` }} />
      </div>

      <div className="timeline-label">
        <span>Execution timeline</span>
        <span>{snapshot.workflowId.slice(-7)}</span>
      </div>
      <ol className="timeline">
        {Array.from({ length: totalSteps }, (_, index) => {
          const step = snapshot.steps[index];
          return (
            <TimelineStep
              key={step?.stepId ?? index}
              index={index}
              step={step}
              variant={variant}
              now={now}
            />
          );
        })}
      </ol>
      {snapshot.status.type === "failed" ? (
        <div className="workflow-error">
          {snapshot.status.error ?? "Workflow failed"}
        </div>
      ) : null}
    </article>
  );
}

function TimelineStep({
  index,
  step,
  variant,
  now,
}: {
  index: number;
  step?: StepSnapshot;
  variant: "traditional" | "action";
  now: number;
}) {
  const state = !step
    ? "queued"
    : step.resultKind === "failed"
      ? "failed"
      : step.completedAt
        ? "complete"
        : "running";
  const duration = step
    ? Math.max(0, (step.completedAt ?? now) - step.startedAt)
    : null;
  const fallbackNames = ["Query", "Mutation", "Action"];
  const name = step?.name ?? `${fallbackNames[index % 3]} ${index + 1}`;

  return (
    <li className={`timeline-step ${state}`}>
      <span className="timeline-node">
        {state === "complete" ? <CheckIcon /> : index + 1}
      </span>
      <div className="timeline-copy">
        <strong>{name}</strong>
        <span>
          {state === "queued"
            ? "Waiting"
            : state === "running"
              ? variant === "action"
                ? "Running inside action"
                : "Running via workpool"
              : state === "failed"
                ? "Failed"
                : "Completed"}
        </span>
      </div>
      <time>{duration === null ? "—" : formatDuration(duration)}</time>
    </li>
  );
}

function StatusBadge({
  status,
}: {
  status: WorkflowSnapshot["status"]["type"];
}) {
  const label =
    status === "inProgress"
      ? "Running"
      : status === "completed"
        ? "Complete"
        : status === "canceled"
          ? "Canceled"
          : "Failed";
  return (
    <span className={`status-badge ${status}`}>
      <span />
      {label}
    </span>
  );
}

function EmptyState({ onStart }: { onStart: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-visual">
        <span />
        <span />
        <span />
      </div>
      <h2>No comparison runs yet</h2>
      <p>Launch both execution modes to see their journal timelines unfold.</p>
      <button type="button" onClick={onStart}>
        Start the first run
      </button>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="loading-state">
      <span />
      Connecting to the workflow journal…
    </div>
  );
}

function useLiveClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 50);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function elapsed(snapshot: WorkflowSnapshot, startedAt: number, now: number) {
  return Math.max(0, (snapshot.completedAt ?? now) - startedAt);
}

function formatDuration(milliseconds: number) {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  return `${(milliseconds / 1_000).toFixed(2)}s`;
}

function RelayMark() {
  return (
    <svg viewBox="0 0 36 36" aria-hidden="true">
      <path d="M7 10.5h13.5a6 6 0 0 1 6 6v0" />
      <path d="m22 12.5 4.5 4-4.5 4" />
      <path d="M29 25.5H15.5a6 6 0 0 1-6-6v0" />
      <path d="m14 23.5-4.5-4 4.5-4" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m7 5 7 5-7 5V5Z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m3 8.5 3 3 7-7" />
    </svg>
  );
}
