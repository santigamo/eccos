import { describe, it, expect } from "bun:test";
import { signPayload, verifyMetaSignature, constantTimeEqual } from "@eccos/core/signature";

describe("signature", () => {
  const secret = "test-app-secret";
  const body = '{"hello":"world"}';

  it("signPayload returns sha256= prefix with 64 hex chars", async () => {
    const sig = await signPayload(body, secret);
    expect(sig.startsWith("sha256=")).toBe(true);
    expect(sig.slice(7)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifyMetaSignature round-trips with signPayload", async () => {
    const header = await signPayload(body, secret);
    expect(await verifyMetaSignature(body, header, secret)).toBe(true);
  });

  it("verifyMetaSignature rejects wrong signature", async () => {
    const wrong = await signPayload(body, "other-secret");
    expect(await verifyMetaSignature(body, wrong, secret)).toBe(false);
  });

  it("verifyMetaSignature rejects null header", async () => {
    expect(await verifyMetaSignature(body, null, secret)).toBe(false);
  });

  it("verifyMetaSignature rejects header without sha256= prefix", async () => {
    expect(await verifyMetaSignature(body, "deadbeef", secret)).toBe(false);
  });

  it("constantTimeEqual compares strings safely", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});
