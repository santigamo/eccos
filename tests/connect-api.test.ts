import { describe, expect, it } from "bun:test";
import { extractTokenTargetIds } from "../worker/meta/connect-api";

describe("extractTokenTargetIds", () => {
  it("extracts unique WhatsApp granular scope targets", () => {
    expect(
      extractTokenTargetIds({
        data: {
          granular_scopes: [
            { scope: "public_profile", target_ids: ["ignored"] },
            { scope: "whatsapp_business_management", target_ids: ["waba-1", "waba-2"] },
            { scope: "whatsapp_business_messaging", target_ids: ["waba-1"] },
          ],
        },
      }),
    ).toEqual(["waba-1", "waba-2"]);
  });
});
