/**
 * Preloaded for every dashboard test (bunfig.toml). Better Auth hashes each password with scrypt
 * (~30 ms a call), and the suites that sign users up hash hundreds of them. Tests check who may
 * sign in, not the KDF, so a reversible stand-in keeps a wrong password wrong at no cost.
 */
import { mock } from "bun:test";
import { dirname } from "node:path";

const betterAuth = dirname(Bun.resolveSync("better-auth/crypto", import.meta.dir));

mock.module(Bun.resolveSync("@better-auth/utils/password", betterAuth), () => ({
  hashPassword: async (password: string) => `test-hash:${password}`,
  verifyPassword: async (hash: string, password: string) => hash === `test-hash:${password}`,
}));
