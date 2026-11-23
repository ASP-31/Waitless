import { ERROR_CODES } from "@waitless/shared";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/utils/errors";
import { normalizePhone, safeName } from "../src/utils/phone";

/** Assert the stable code/status contract rather than message wording. */
function expectAppError(run: () => unknown, code: string, status: number, field: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  const appError = caught as AppError;
  expect(appError.code).toBe(code);
  expect(appError.status).toBe(status);
  expect(appError.details).toEqual({ field });
}

describe("normalizePhone", () => {
  it.each([
    ["9876543210", "+919876543210"],
    ["98765 43210", "+919876543210"],
    ["98765-43210", "+919876543210"],
    ["(98765) 43210", "+919876543210"],
    [" 98765  43210 ", "+919876543210"],
  ])("accepts a 10-digit Indian mobile written as %s", (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(["+91 98765 43210", "+91-98765-43210", "919876543210"])(
    "strips a +91 / 91 country prefix from %s",
    (input) => {
      expect(normalizePhone(input)).toBe("+919876543210");
    },
  );

  it.each(["09876543210", "0-98765-43210", "0 98765 43210"])(
    "strips a leading 0 (STD-style) prefix from %s",
    (input) => {
      expect(normalizePhone(input)).toBe("+919876543210");
    },
  );

  it.each([
    "1234567890", // does not start with 6-9
    "987654321", // too short
    "98765432100", // too long, not a 0-prefix
    "abcdefghij",
    "",
  ])("rejects the invalid number %s with INVALID_PHONE/422", (input) => {
    expectAppError(
      () => normalizePhone(input),
      ERROR_CODES.INVALID_PHONE,
      422,
      "phone",
    );
  });
});

describe("safeName", () => {
  it("trims and collapses internal whitespace", () => {
    expect(safeName("  Rohan   Kumar  ")).toBe("Rohan Kumar");
    expect(safeName("Ananya\tDesai")).toBe("Ananya Desai");
  });

  it.each(["", " ", "A"])("rejects the too-short name %s with BAD_REQUEST/400", (input) => {
    expectAppError(() => safeName(input), ERROR_CODES.BAD_REQUEST, 400, "fullName");
  });
});
