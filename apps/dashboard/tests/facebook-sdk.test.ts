import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { loadFacebookSdk } = await import("../src/lib/facebook-sdk");

test("a script that fails to load is removed, so the next call really reloads", async () => {
  const scripts: HTMLScriptElement[] = [];
  let removed = 0;
  // Fail like a browser does: asynchronously, after the tag is attached.
  document.head.appendChild = ((node: HTMLScriptElement) => {
    scripts.push(node);
    node.remove = () => {
      removed += 1;
    };
    setTimeout(() => node.dispatchEvent(new Event("error")), 0);
    return node;
  }) as unknown as typeof document.head.appendChild;

  await expect(loadFacebookSdk("1", "v25.0")).rejects.toThrow("could not be loaded");
  expect(removed).toBe(1);
  await expect(loadFacebookSdk("1", "v25.0")).rejects.toThrow("could not be loaded");
  expect(scripts.length).toBe(2);
});
