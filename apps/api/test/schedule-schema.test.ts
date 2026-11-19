import { describe, expect, it } from "vitest";
import { scheduleCreateSchema, scheduleUpdateSchema } from "../src/modules/doctors/schedule.schema";

describe("schedule schemas", () => {
  it("accepts a valid create payload", () => {
    expect(
      scheduleCreateSchema.safeParse({
        dayOfWeek: 1,
        startMinute: 540,
        endMinute: 600,
      }).success,
    ).toBe(true);
  });

  it("rejects create payloads whose end is not after their start", () => {
    expect(
      scheduleCreateSchema.safeParse({
        dayOfWeek: 1,
        startMinute: 600,
        endMinute: 540,
      }).success,
    ).toBe(false);
  });

  it("supports partial updates without crashing on schema construction", () => {
    expect(scheduleUpdateSchema.safeParse({ endMinute: 600 }).success).toBe(true);
    expect(
      scheduleUpdateSchema.safeParse({
        startMinute: 600,
        endMinute: 540,
      }).success,
    ).toBe(false);
  });
});
