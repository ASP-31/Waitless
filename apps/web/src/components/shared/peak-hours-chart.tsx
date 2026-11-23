import { cn } from "@/lib/utils";

export interface PeakHour {
  hour: number;
  count: number;
}

/** Dependency-free SVG bar chart for the analytics peak-hours series. */
export function PeakHoursChart({ hours, className }: { hours: PeakHour[]; className?: string }) {
  const width = 640;
  const height = 200;
  const left = 36;
  const right = 10;
  const top = 14;
  const bottom = 32;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const max = Math.max(1, ...hours.map((entry) => entry.count));
  const slots = hours.length || 1;
  const slotWidth = plotWidth / slots;
  const barWidth = Math.max(4, slotWidth * 0.6);
  const labelEvery = Math.max(1, Math.ceil(slots / 6));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={cn("h-48 w-full", className)}
      role="img"
      aria-label={hours.length ? `Appointments by hour, peak ${max} appointments` : "No appointment data for this period"}
      preserveAspectRatio="none"
    >
      {[0, 0.5, 1].map((fraction) => {
        const y = top + plotHeight * (1 - fraction);
        return (
          <g key={fraction}>
            <line x1={left} x2={width - right} y1={y} y2={y} className="stroke-border" strokeDasharray="4 4" />
            <text x={left - 6} y={y + 3} textAnchor="end" className="fill-muted-foreground text-[10px]">
              {Math.round(max * fraction)}
            </text>
          </g>
        );
      })}

      {hours.map((entry, index) => {
        const barHeight = entry.count > 0 ? Math.max(2, (entry.count / max) * plotHeight) : 0;
        const x = left + index * slotWidth + (slotWidth - barWidth) / 2;
        const y = top + plotHeight - barHeight;
        return (
          <g key={`${entry.hour}-${index}`}>
            <rect x={x} y={y} width={barWidth} height={barHeight} rx={Math.min(3, barWidth / 2)} className="fill-primary/75">
              <title>{`${entry.hour}:00 — ${entry.count} appointment${entry.count === 1 ? "" : "s"}`}</title>
            </rect>
            {index % labelEvery === 0 && (
              <text
                x={left + index * slotWidth + slotWidth / 2}
                y={height - 10}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {`${entry.hour}:00`}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
