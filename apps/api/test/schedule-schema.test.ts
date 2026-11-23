import { describe, expect, it } from "vitest";
import { scheduleCreateSchema, scheduleUpdateSchema } from "../src/modules/doctors/schedule.schema";

describe("schedule schemas", () => {
  it("parses a valid create payload and defaults slotMinutes", () => {
    expect(scheduleCreateSchema.parse({ dayOfWeek: 1, startMinute: 540, endMinute: 600 })).toEqual({
      dayOfWeek: 1,
      startMinute: 540,
      endMinute: 600,
      slotMinutes: 15,
    });
  });

  it("rejects reversed create times", () => {
    expect(scheduleCreateSchema.safeParse({ dayOfWeek: 1, startMinute: 600, endMinute: 540 }).success).toBe(false);
  });

  it("accepts partial updates without applying create defaults", () => {
    expect(scheduleUpdateSchema.parse({ endMinute: 660 })).toEqual({ endMinute: 660 });
    expect(scheduleUpdateSchema.parse({ isActive: false })).toEqual({ isActive: false });
  });

  it("rejects reversed times only when both update endpoints are supplied", () => {
    expect(scheduleUpdateSchema.safeParse({ startMinute: 600, endMinute: 540 }).success).toBe(false);
    expect(scheduleUpdateSchema.safeParse({ startMinute: 600 }).success).toBe(true);
    expect(scheduleUpdateSchema.safeParse({ endMinute: 540 }).success).toBe(true);
  });
});
