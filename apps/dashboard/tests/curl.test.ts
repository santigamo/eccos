import { describe, expect, test } from "bun:test";
import { broadcastCurl, scheduledCurl, tomorrowAtNine } from "../src/lib/curl";
import { sendSnippet } from "../src/components/dashboard/api-keys";

describe("API requests the console prints", () => {
  test("the send request keeps its layout", () => {
    expect(sendSnippet({ wabaId: "waba-a", gatewayOrigin: "https://gw.example", apiKey: "ek_1", to: "346" })).toBe(
      `curl -X POST https://gw.example/v1/wabas/waba-a/messages \\
  -H "Authorization: Bearer ek_1" \\
  -H "Content-Type: application/json" \\
  -d '{"to": "346", "type": "template", "template": {"name": "hello_world", "language": {"code": "en_US"}}}'`,
    );
  });

  test("a broadcast fills the WABA and the origin, never a key, and carries an idempotency key", () => {
    const curl = broadcastCurl("1029384756", "https://api.eccos.chat");
    expect(curl).toStartWith("curl -X POST https://api.eccos.chat/v1/wabas/1029384756/broadcasts \\");
    expect(curl).toContain('-H "Authorization: Bearer <API_KEY>"');
    expect(curl).toContain('-H "Idempotency-Key: ');
    expect(curl).toContain('"to": "<PHONE>"');
    expect(curl).toContain('"name": "<TEMPLATE_NAME>"');
    expect(JSON.parse(curl.slice(curl.indexOf("-d '") + 4, -1)).recipients).toHaveLength(1);
  });

  test("placeholders while the WABA or the origin is unknown", () => {
    expect(scheduledCurl(undefined, null, "2026-11-28T09:00:00+01:00")).toStartWith(
      "curl -X PUT <GATEWAY_URL>/v1/wabas/<WABA_ID>/scheduled/appt-8812 \\",
    );
  });

  test("a scheduled send's body parses and names its time with an offset", () => {
    const curl = scheduledCurl("w", "https://o", "2026-11-28T09:00:00+01:00");
    expect(JSON.parse(curl.slice(curl.indexOf("-d '") + 4, -1)).sendAt).toBe("2026-11-28T09:00:00+01:00");
    expect(tomorrowAtNine(new Date(2026, 10, 27, 15))).toMatch(/^2026-11-28T09:00:00[+-]\d{2}:\d{2}$/);
  });
});
