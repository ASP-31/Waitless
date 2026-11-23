/** Small, dependency-free formatting helpers shared across the web app. */

export interface EtaRange {
  min: number;
  max: number;
}

/** Formats an API ETA range as e.g. "10–20 min" (or a sensible fallback). */
export function formatEtaRange(range: EtaRange | null | undefined): string {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return "—";
  const min = Math.max(0, Math.round(range.min));
  const max = Math.max(min, Math.round(range.max));
  if (max === 0) return "Now";
  if (min === max) return `${min} min`;
  return `${min}–${max} min`;
}

/** Coarse countdown used on swap cards ("12m left", "Expired"). */
export function formatCountdown(expiresAt: string | null | undefined, now: number = Date.now()): string {
  if (!expiresAt) return "—";
  const target = new Date(expiresAt).getTime();
  if (!Number.isFinite(target)) return "—";
  const remaining = target - now;
  if (remaining <= 0) return "Expired";
  const totalMinutes = Math.floor(remaining / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return `${minutes}m ${seconds}s left`;
}

/** mm:ss elapsed time for called patients. */
export function formatElapsed(fromIso: string | null | undefined, now: number = Date.now()): string {
  if (!fromIso) return "—";
  const start = new Date(fromIso).getTime();
  if (!Number.isFinite(start)) return "—";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Local calendar date (YYYY-MM-DD) — avoids UTC off-by-one for IST clinics. */
export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Human-friendly relative timestamp for heartbeats and "last updated". */
export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "Never";
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "Unknown";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
