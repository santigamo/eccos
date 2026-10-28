import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { deleteMediaForWaba, getMedia, putMedia } from "../../src/media-store";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

afterEach(async () => {
  await reset();
});

describe("media store (R2)", () => {
  it("round-trips the body with content type and sha256 metadata", async () => {
    const body = "fake-image-bytes";
    const sha256 = await sha256Hex(body);
    await putMedia(env.MEDIA, { wabaId: "WABA_A", mediaId: "1234567890", body, contentType: "image/jpeg", sha256 });

    const stored = await getMedia(env.MEDIA, "WABA_A", "1234567890");
    expect(stored).not.toBeNull();
    expect(await new Response(stored!.body).text()).toBe(body);
    expect(stored!.contentType).toBe("image/jpeg");
    expect(stored!.sha256).toBe(sha256);
    expect(stored!.size).toBe(body.length);
  });

  it("writes under the WABA prefix and returns null for a missing object", async () => {
    await putMedia(env.MEDIA, { wabaId: "WABA_A", mediaId: "42", body: "x", contentType: "text/plain" });

    expect((await env.MEDIA.list({ prefix: "waba/WABA_A/media/" })).objects.map((o) => o.key)).toEqual([
      "waba/WABA_A/media/42",
    ]);
    expect(await getMedia(env.MEDIA, "WABA_A", "43")).toBeNull();
    expect(await getMedia(env.MEDIA, "WABA_B", "42")).toBeNull();
  });

  it("rejects a sha256 that does not match the bytes", async () => {
    await expect(
      putMedia(env.MEDIA, { wabaId: "WABA_A", mediaId: "7", body: "abc", contentType: "text/plain", sha256: "0".repeat(64) }),
    ).rejects.toThrow();
    expect(await getMedia(env.MEDIA, "WABA_A", "7")).toBeNull();
  });

  it("keeps WABAs isolated, including a WABA id that is a prefix of another", async () => {
    await putMedia(env.MEDIA, { wabaId: "WABA_A", mediaId: "1", body: "a", contentType: "text/plain" });
    await putMedia(env.MEDIA, { wabaId: "WABA_A2", mediaId: "1", body: "a2", contentType: "text/plain" });

    expect(await deleteMediaForWaba(env.MEDIA, "WABA_A")).toBe(1);
    expect(await getMedia(env.MEDIA, "WABA_A", "1")).toBeNull();
    expect(await new Response((await getMedia(env.MEDIA, "WABA_A2", "1"))!.body).text()).toBe("a2");
  });

  it("rejects ids that could escape the WABA prefix", async () => {
    const bad = ["", "../1", "1/2", "abc", "1?x", "1 2"];
    for (const mediaId of bad) {
      await expect(putMedia(env.MEDIA, { wabaId: "WABA_A", mediaId, body: "x", contentType: "text/plain" })).rejects.toThrow(
        "Invalid media ID",
      );
      await expect(getMedia(env.MEDIA, "WABA_A", mediaId)).rejects.toThrow("Invalid media ID");
    }
    for (const wabaId of ["", "WABA/../OTHER", "WABA A", "a.b"]) {
      await expect(deleteMediaForWaba(env.MEDIA, wabaId)).rejects.toThrow("Invalid WABA ID");
    }
    expect((await env.MEDIA.list()).objects).toHaveLength(0);
  });

  it("rejects a malformed sha256 digest", async () => {
    await expect(
      putMedia(env.MEDIA, { wabaId: "WABA_A", mediaId: "8", body: "x", contentType: "text/plain", sha256: "not-hex" }),
    ).rejects.toThrow("Invalid SHA-256 digest");
  });

  it("deletes only the WABA's objects across more than one list page", async () => {
    const PAGE = 1000;
    const TOTAL = PAGE + 1;
    for (let start = 0; start < TOTAL; start += 200) {
      await Promise.all(
        Array.from({ length: Math.min(200, TOTAL - start) }, (_, i) =>
          putMedia(env.MEDIA, { wabaId: "WABA_BULK", mediaId: String(start + i + 1), body: "x", contentType: "text/plain" }),
        ),
      );
    }
    await putMedia(env.MEDIA, { wabaId: "WABA_KEEP", mediaId: "1", body: "x", contentType: "text/plain" });

    expect(await deleteMediaForWaba(env.MEDIA, "WABA_BULK")).toBe(TOTAL);
    expect((await env.MEDIA.list({ prefix: "waba/WABA_BULK/media/" })).objects).toHaveLength(0);
    expect(await getMedia(env.MEDIA, "WABA_KEEP", "1")).not.toBeNull();
  });
});
