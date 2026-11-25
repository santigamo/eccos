import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { installTranslateGuard } from "../src/lib/translate-guard";

const registered = !GlobalRegistrator.isRegistered;
if (registered) GlobalRegistrator.register();
const original = { removeChild: Node.prototype.removeChild, insertBefore: Node.prototype.insertBefore };

beforeAll(() => installTranslateGuard());
afterAll(() => {
  Object.assign(Node.prototype, original);
  if (registered) GlobalRegistrator.unregister();
});

// What Chrome's translator does: moves React's text node into a <font> it owns.
function translated() {
  const parent = document.createElement("p");
  const text = document.createTextNode("Hello");
  parent.appendChild(text);
  const font = document.createElement("font");
  parent.replaceChild(font, text);
  font.appendChild(text);
  return { parent, text, font };
}

describe("translate guard", () => {
  test("removing a node the translator moved away is a no-op, not a crash", () => {
    const { parent, text } = translated();
    expect(() => parent.removeChild(text)).not.toThrow();
  });

  test("inserting before a moved reference node is a no-op, not a crash", () => {
    const { parent, text } = translated();
    expect(() => parent.insertBefore(document.createElement("span"), text)).not.toThrow();
  });

  test("ordinary DOM work is untouched", () => {
    const parent = document.createElement("div");
    const a = parent.appendChild(document.createElement("a"));
    const b = parent.insertBefore(document.createElement("b"), a);
    expect([...parent.childNodes]).toEqual([b, a]);
    parent.removeChild(a);
    expect([...parent.childNodes]).toEqual([b]);
  });
});
