import { describe, expect, test } from "bun:test";
import { slugifyWorkspaceName } from "../src/components/blocks/auth-13/components/workspace-form";

describe("slugifyWorkspaceName", () => {
  test("lowercases and dashes multi-word names", () => {
    expect(slugifyWorkspaceName("Physeo Clínica")).toBe("physeo-clinica");
    expect(slugifyWorkspaceName("Acme Corp")).toBe("acme-corp");
  });

  test("strips accents (NFKD) so unicode names produce ascii slugs", () => {
    expect(slugifyWorkspaceName("Clínica Dental")).toBe("clinica-dental");
    expect(slugifyWorkspaceName("ÜBER-health")).toBe("uber-health");
  });

  test("collapses non-alphanumerics to single dashes", () => {
    expect(slugifyWorkspaceName("A  B!!")).toBe("a-b");
    expect(slugifyWorkspaceName("a---b")).toBe("a-b");
  });

  test("trims leading/trailing dashes and caps length at 48", () => {
    expect(slugifyWorkspaceName("--hi--")).toBe("hi");
    expect(slugifyWorkspaceName("x".repeat(60)).length).toBe(48);
    expect(slugifyWorkspaceName("y".repeat(60)).endsWith("-")).toBe(false);
  });

  test("empty name yields empty slug", () => {
    expect(slugifyWorkspaceName("")).toBe("");
    expect(slugifyWorkspaceName("   ")).toBe("");
    expect(slugifyWorkspaceName("!!!")).toBe("");
  });
});
