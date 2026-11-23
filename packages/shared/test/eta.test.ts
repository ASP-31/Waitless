import { describe, expect, it } from "vitest";
import {
  clampConsultMinutes,
  countAhead,
  estimateWaitMinutes,
  etaRange,
  rollingAverageMinutes,
} from "../src/eta";
import type { EtaInputEntry } from "../src/eta";

const entry = (status: string, avgConsultMinutes: number, position = 1): EtaInputEntry => ({
  status,
  position,
  avgConsultMinutes,
});

describe("estimateWaitMinutes", () => {
  it("returns zero for an empty queue", () => {
    expect(estimateWaitMinutes([])).toBe(0);
  });

  it("uses the average of the one patient ahead", () => {
    expect(estimateWaitMinutes([entry("WAITING", 12)])).toBe(12);
    expect(estimateWaitMinutes([entry("IN_CONSULTATION", 18)], 12)).toBe(18);
  });

  it("sums every blocking entry in front of the patient", () => {
    const ahead = [
      entry("IN_CONSULTATION", 9, 1),
      entry("CALLED", 11, 2),
      entry("NOTIFIED", 13, 3),
      entry("DELAYED", 15, 4),
      entry("WAITING", 17, 5),
    ];
    expect(estimateWaitMinutes(ahead)).toBe(65);
  });

  it("ignores completed, skipped, cancelled and no-show entries", () => {
    const ahead = [
      entry("COMPLETED", 60, 1),
      entry("SKIPPED", 60, 2),
      entry("CANCELLED", 60, 3),
      entry("NO_SHOW", 60, 4),
      entry("WAITING", 8, 5),
    ];
    expect(estimateWaitMinutes(ahead)).toBe(8);
    expect(countAhead(ahead)).toBe(1);
  });

  it("treats DELAYED and NOTIFIED as still occupying a slot", () => {
    expect(estimateWaitMinutes([entry("DELAYED", 10), entry("NOTIFIED", 10)])).toBe(20);
    expect(countAhead([entry("DELAYED", 1), entry("NOTIFIED", 1), entry("COMPLETED", 1)])).toBe(2);
  });

  it("handles a zero-variance queue without drifting", () => {
    const ahead = [entry("WAITING", 12), entry("WAITING", 12), entry("WAITING", 12)];
    expect(estimateWaitMinutes(ahead)).toBe(36);
  });

  it("clamps an outsize long-consult outlier to 60 minutes", () => {
    expect(estimateWaitMinutes([entry("WAITING", 600), entry("WAITING", 12)])).toBe(72);
  });

  it("falls back to the doctor default for a missing/zero average", () => {
    expect(estimateWaitMinutes([entry("WAITING", 0)], 9)).toBe(9);
    expect(estimateWaitMinutes([entry("WAITING", Number.NaN)], 9)).toBe(9);
  });

  it("clamps very short and non-finite estimates via clampConsultMinutes", () => {
    expect(clampConsultMinutes(0)).toBe(3);
    expect(clampConsultMinutes(1)).toBe(3);
    expect(clampConsultMinutes(12.6)).toBe(13);
    expect(clampConsultMinutes(120)).toBe(60);
    expect(clampConsultMinutes(Number.NaN)).toBe(12);
    expect(clampConsultMinutes(Number.POSITIVE_INFINITY)).toBe(12);
  });
});

describe("rollingAverageMinutes", () => {
  it("uses only the last 10 samples, dropping an older long-consult outlier", () => {
    const durations = [7200, ...Array.from({ length: 10 }, () => 600)]; // 120 min outlier, then 10 x 10 min
    expect(rollingAverageMinutes(durations, 12, 10)).toBe(10);
  });

  it("drops zero, negative and non-finite samples from the window", () => {
    expect(rollingAverageMinutes([Number.NaN, 0, -60, 900], 12, 10)).toBe(15);
  });

  it("clamps the computed average into the 3–60 minute band", () => {
    expect(rollingAverageMinutes([60], 12)).toBe(3);
    expect(rollingAverageMinutes([7200], 12)).toBe(60);
  });

  it("falls back to a clamped default when there are no usable samples", () => {
    expect(rollingAverageMinutes([], 12)).toBe(12);
    expect(rollingAverageMinutes([], 1)).toBe(3);
    expect(rollingAverageMinutes([], 999)).toBe(60);
  });
});

describe("etaRange", () => {
  it("formats a ±20% window rounded to five minutes", () => {
    expect(etaRange(20)).toEqual({ min: 15, max: 25 });
    expect(etaRange(100)).toEqual({ min: 80, max: 120 });
  });

  it("keeps a minimum five-minute spread and never goes below zero", () => {
    expect(etaRange(0)).toEqual({ min: 0, max: 5 });
    expect(etaRange(1)).toEqual({ min: 0, max: 5 });
    expect(etaRange(12)).toEqual({ min: 5, max: 15 });
  });
});
