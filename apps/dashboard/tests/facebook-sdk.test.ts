import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { loadFacebookSdk } = await import("../src/lib/facebook-sdk.ts?fresh-module-state");

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

test("a failed script's late event cannot null a newer pending load", async () => {
  const nodes: HTMLScriptElement[] = [];
  document.head.appendChild = ((node: HTMLScriptElement) => {
    nodes.push(node);
    node.remove = () => {};
    return node;
  }) as unknown as typeof document.head.appendChild;

  const first = loadFacebookSdk("1", "v25.0");
  first.catch(() => {});
  nodes[0]?.dispatchEvent(new Event("error"));
  await expect(first).rejects.toThrow();

  const second = loadFacebookSdk("1", "v25.0");
  second.catch(() => {});
  nodes[0]?.dispatchEvent(new Event("error"));
  expect(loadFacebookSdk("1", "v25.0")).toBe(second);
  nodes[1]?.dispatchEvent(new Event("error"));
  await expect(second).rejects.toThrow();
});

test("an SDK that finished loading after a failure is initialised and used", async () => {
  let inits = 0;
  const fb = { init: () => {
      inits += 1;
    }, login: () => {} };
  (window as unknown as { FB: unknown }).FB = fb;
  expect(await loadFacebookSdk("1", "v25.0")).toBe(fb as never);
  await loadFacebookSdk("1", "v25.0");
  expect(inits).toBe(1);
});
