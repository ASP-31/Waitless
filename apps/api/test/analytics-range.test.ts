import { describe, expect, it } from "vitest";
import { resolveRange } from "../src/modules/analytics/analytics.schema";

describe("analytics date range", () => {
  it("defaults both ends to today when omitted", () => {
    const range = resolveRange({});
    expect(range.from).toBe(range.to);
    expect(range.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("keeps an explicit inclusive range", () => {
    expect(resolveRange({ from: "2026-11-01", to: "2026-11-07" })).toEqual({
      from: "2026-11-01",
      to: "2026-11-07",
    });
  });

  it("defaults `from` to the end date", () => {
    expect(resolveRange({ to: "2026-11-05" })).toEqual({ from: "2026-11-05", to: "2026-11-05" });
  });

  it("rejects a reversed range", () => {
    expect(() => resolveRange({ from: "2026-11-10", to: "2026-11-01" })).toThrow(/on or before/);
  });
});
