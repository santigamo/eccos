import { describe, expect, test } from "bun:test";
import { waIdOf } from "../src/conversations";
import { mapSyncItem } from "../src/history";

const BSUID = "US.13491208655302741918";

describe("conversation keys for business-scoped user ids", () => {
  test("a phone number is reduced to digits, a BSUID is kept whole", () => {
    expect(waIdOf("+34 600-00-00-00")).toBe("34600000000");
    expect(waIdOf(BSUID)).toBe(BSUID);
    expect(waIdOf("US.ENT.11815799212886844830")).toBe("US.ENT.11815799212886844830");
  });

  test("a history message from a phone-less customer is inbound, keyed by the BSUID thread", () => {
    const unit = mapSyncItem(
      {
        kind: "message",
        metadata: { display_phone_number: "15550783881", phone_number_id: "PHONE_ID" },
        business: "15550783881",
        threadId: BSUID,
        raw: { from_user_id: BSUID, id: "wamid.H", timestamp: "1700000000", type: "text", text: { body: "Hi" } },
      },
      "WABA_ID",
    );
    expect(unit).toMatchObject({ kind: "message", message: { waId: BSUID, direction: "in", origin: "history" } });
  });

  test("an app-state contact Meta sends without a phone number is keyed by its BSUID", () => {
    const contact = (fields: Record<string, unknown>) =>
      mapSyncItem({ kind: "contact", action: "add", contact: { full_name: "Ana", ...fields } }, "WABA_ID");
    expect(contact({ user_id: BSUID })).toEqual({ kind: "contact", waId: BSUID, name: "Ana", action: "add" });
    expect(contact({ phone_number: "+34 600 000 001", user_id: BSUID })).toMatchObject({ waId: "34600000001" });
    expect(contact({})).toBeNull();
  });
});
