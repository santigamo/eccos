import { afterEach, expect, spyOn, test } from "bun:test";
import { diagnoseWaba } from "../src/meta/waba-diagnostics";

const cfg = { META_GRAPH_VERSION: "v25.0", META_APP_ID: "APP", META_APP_SECRET: "SECRET" } as never;
const TOKEN = "CUSTOMER_TOKEN";

afterEach(() => (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.());

test("only reads, isolates a rejected field and never returns a credential", async () => {
  const methods: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation((async (input: string, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.includes("/debug_token")) {
      return json({ data: { app_id: "APP", is_valid: true, scopes: ["whatsapp_business_messaging"], access_token: TOKEN } });
    }
    if (url.includes("fields=country")) return json({ error: { message: "no such field", code: 100 } }, 400);
    if (url.includes("subscribed_apps")) {
      return json({ data: [{ id: "A" }], paging: { next: `https://x?access_token=${TOKEN}` } });
    }
    const field = new URL(url).searchParams.get("fields") as string;
    return json({ [field]: "ok", id: "N" });
  }) as never);

  const result = await diagnoseWaba(cfg, "W", "P", TOKEN);

  expect(new Set(methods)).toEqual(new Set(["GET"]));
  expect(result.token.scopes).toEqual(["whatsapp_business_messaging"]);
  expect(result.waba.country).toMatchObject({ status: 400, code: 100 });
  expect(result.waba.name).toBe("ok");
  expect(result.phone?.status).toBe("ok");
  expect(JSON.stringify(result)).not.toContain(TOKEN);
  expect(JSON.stringify(result)).not.toContain("SECRET");
});
