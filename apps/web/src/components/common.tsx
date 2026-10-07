import type { CallStatus } from "@calls/shared";
import type { ReactNode } from "react";

export const STATUS: Record<CallStatus, { label: string; color: string; hint: string }> = {
  ringing: { label: "Ringing", color: "var(--ringing)", hint: "In progress" },
  connected: { label: "Connected", color: "var(--connected)", hint: "Answered by a person" },
  missed: { label: "Missed", color: "var(--missed)", hint: "No answer, voicemail or abandoned" },
  converted: { label: "Converted", color: "var(--converted)", hint: "Led to a sale, booking or quote" },
};

export function StatusChip({ status }: { status: CallStatus }) {
  const s = STATUS[status];
  return (
    <span className="status" style={{ color: s.color }} title={s.hint}>
      <span className="dot" style={{ background: s.color }} />
      {s.label}
    </span>
  );
}

export function Skeleton({ height = 16, width = "100%" }: { height?: number; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} aria-hidden />;
}

export function Loading({ height = 260 }: { height?: number }) {
  return (
    <div role="status" aria-busy="true" aria-label="Loading">
      <Skeleton height={height} />
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const msg = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div className="state" role="alert">
      <strong>Couldn’t load this</strong>
      <span>{msg}</span>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state">
      <strong>{title}</strong>
      {children && <span>{children}</span>}
    </div>
  );
}

export function Panel({
  title,
  sub,
  actions,
  className,
  children,
}: {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`panel ${className ?? ""}`} aria-label={title}>
      <div className="panel-head">
        <h2>{title}</h2>
        {sub && <span className="sub">{sub}</span>}
        <span className="spacer" />
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean; title?: string }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <fieldset className="seg">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          disabled={o.disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}
