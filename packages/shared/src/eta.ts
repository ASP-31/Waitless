export interface EtaInputEntry {
  status: string;
  position: number;
  avgConsultMinutes: number;
}

const QUEUE_AHEAD = new Set(["WAITING", "NOTIFIED", "CALLED", "DELAYED", "IN_CONSULTATION"]);

/** Rolling average of the last N completed consultations, clamped to 3–60 min. */
export function rollingAverageMinutes(
  durationSeconds: readonly number[],
  fallbackMinutes = 12,
  sampleSize = 10,
): number {
  const sample = durationSeconds.filter((value) => Number.isFinite(value) && value > 0).slice(-sampleSize);
  if (!sample.length) return clampConsultMinutes(fallbackMinutes);
  const average = sample.reduce((sum, value) => sum + value, 0) / sample.length / 60;
  return clampConsultMinutes(average);
}

export function clampConsultMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return 12;
  return Math.max(3, Math.min(60, Math.round(minutes)));
}

/** Sum of the (clamped) consultation averages of everybody still ahead. */
export function estimateWaitMinutes(entriesAhead: EtaInputEntry[], fallbackMinutes = 12): number {
  const blocking = entriesAhead.filter((entry) => QUEUE_AHEAD.has(entry.status));
  if (!blocking.length) return 0;
  const mins = blocking.reduce(
    (sum, entry) => sum + clampConsultMinutes(entry.avgConsultMinutes || fallbackMinutes),
    0,
  );
  return Math.max(0, Math.round(mins));
}

export function countAhead(entries: Array<{ status: string }>): number {
  return entries.filter((entry) => QUEUE_AHEAD.has(entry.status)).length;
}

/** Patient-friendly ETA range: ±20%, rounded to the nearest 5 minutes. */
export function etaRange(estimatedWaitMinutes: number): { min: number; max: number } {
  const spread = Math.max(5, Math.round(estimatedWaitMinutes * 0.2 / 5) * 5);
  return {
    min: Math.max(0, Math.round((estimatedWaitMinutes - spread) / 5) * 5),
    max: Math.round((estimatedWaitMinutes + spread) / 5) * 5,
  };
}
