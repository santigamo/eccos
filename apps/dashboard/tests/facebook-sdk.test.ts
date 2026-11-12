import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, expect, test } from "bun:test";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());

const { currentFacebookSdk, loadFacebookSdk } = await import("../src/lib/facebook-sdk.ts?fresh-module-state");

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

test("the click uses the current window.FB, initialised, after Meta's loader replaced it", async () => {
  const calls: string[] = [];
  const stub = { init: () => calls.push("stub.init"), login: () => calls.push("stub.login") };
  (window as unknown as { FB: unknown }).FB = stub;
  const loaded = await loadFacebookSdk("1", "v25.0");
  const real = { init: () => calls.push("real.init"), login: () => calls.push("real.login") };
  (window as unknown as { FB: unknown }).FB = real;
  currentFacebookSdk()?.login(() => {}, {});
  expect(loaded).toBe(stub as never);
  expect(calls).toEqual(["stub.init", "real.init", "real.login"]);
  currentFacebookSdk();
  expect(calls.filter((c) => c === "real.init")).toHaveLength(1);
});
