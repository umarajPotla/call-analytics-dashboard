import { describe, expect, it } from "vitest";
import { maskCallerNumber } from "./caller";

describe("maskCallerNumber", () => {
  it("keeps the area code and last two digits only", () => {
    expect(maskCallerNumber("+1 (415) 555-0142")).toBe("(415) ***-**42");
    expect(maskCallerNumber("4155550142")).toBe("(415) ***-**42");
  });
  it("masks non-US numbers and drops junk", () => {
    expect(maskCallerNumber("+44 20 7946 0958")).toBe("+** *** ***58");
    expect(maskCallerNumber("12")).toBeNull();
    expect(maskCallerNumber(undefined)).toBeNull();
  });
});
