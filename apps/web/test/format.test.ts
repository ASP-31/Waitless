import { describe, expect, it } from "vitest";
import { formatCountdown, formatElapsed, formatEtaRange, toDateKey } from "@/lib/format";
import { urlBase64ToUint8Array } from "@/lib/notifications";

describe("queue & notification formatting", () => {
  it("formats ETA ranges with sane fallbacks", () => {
    expect(formatEtaRange({ min: 10, max: 20 })).toBe("10–20 min");
    expect(formatEtaRange({ min: 0, max: 0 })).toBe("Now");
    expect(formatEtaRange({ min: 18.4, max: 18.4 })).toBe("18 min");
    expect(formatEtaRange(null)).toBe("—");
  });

  it("formats swap countdowns against an explicit clock", () => {
    const now = new Date("2026-01-01T10:00:00.000Z").getTime();
    expect(formatCountdown("2026-01-01T10:12:30.000Z", now)).toBe("12m 30s left");
    expect(formatCountdown("2026-01-01T09:59:59.000Z", now)).toBe("Expired");
    expect(formatCountdown(undefined, now)).toBe("—");
  });

  it("formats elapsed call timers", () => {
    const now = new Date("2026-01-01T10:00:00.000Z").getTime();
    expect(formatElapsed("2026-01-01T09:57:55.000Z", now)).toBe("02:05");
    expect(formatElapsed(null, now)).toBe("—");
  });

  it("uses local calendar dates and decodes VAPID keys", () => {
    expect(toDateKey(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
    expect(Array.from(urlBase64ToUint8Array("aGVsbG8"))).toEqual([104, 101, 108, 108, 111]);
  });
});
