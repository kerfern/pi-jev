import { describe, expect, it } from "vitest";
import { EnforcementEpoch } from "../src/enforcement.ts";

describe("enforcement epoch", () => {
  it("keeps a call's invalidated scope until terminal cleanup", () => {
    const enforcement = new EnforcementEpoch();
    const original = enforcement.captureCall("call-1");

    expect(enforcement.callScope("call-1")).toBe(original);
    enforcement.invalidate();
    expect(original.signal.aborted).toBe(true);
    expect(enforcement.isCurrent(original)).toBe(false);
    expect(enforcement.captureCall("call-1")).toBe(original);

    enforcement.releaseCall("call-1");
    const fresh = enforcement.captureCall("call-1");
    expect(fresh).not.toBe(original);
    expect(enforcement.isCurrent(fresh)).toBe(true);
  });
});
