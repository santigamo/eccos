import { mock } from "bun:test";

/**
 * THE ONE FAKE for the runtime shims a server module imports: TanStack Start's
 * `createServerFn`, its `getRequest`, and the Workers `env`.
 *
 * Every test that imports a `src/` module touching those must install them
 * through here, and must call this BEFORE `await import`ing the module under
 * test. What follows is why this is a shared helper rather than eight copies,
 * and it is the load-bearing part of this file.
 *
 * ── HOW BUN'S `mock.module` ACTUALLY BEHAVES ────────────────────────────────
 * Registrations are process-global and the module cache never resets between
 * test files, which produces TWO different rules for two different moments:
 *
 *  - **Eval-time captures: the FIRST evaluation wins, forever.** A src module
 *    evaluates once, under whichever registration happens to be live at that
 *    instant, and everything its top level does — every
 *    `createServerFn(...).validator(...).handler(...)` chain — is baked from
 *    that fake for the whole process. Later registrations never re-run it.
 *  - **Call-time reads: the LATEST registration wins.** Re-registering
 *    retro-patches the live bindings of modules that already evaluated, so
 *    `getRequest()` and `env.GATEWAY`, both read inside handlers, always see
 *    the current file's registration.
 *
 * Which file evaluates a src module first is bun's directory-walk order. That
 * order is NOT alphabetical, it differs between macOS and CI's Linux, and it
 * reshuffles when files are merely added or renamed. Nobody controls it.
 *
 * ── WHAT THAT COST US ───────────────────────────────────────────────────────
 * The eight files that used to declare this fake inline did not agree: seven
 * had `validator: (_v) => api`, a no-op, and one ran the validator. So a change
 * making one of them faithful passed when that file ran alone and failed in the
 * full run — the file that evaluates first had baked the other behaviour in.
 * Worse, it was already producing two silently different semantics: the
 * faithful file runs early enough to govern `src/organizations.ts` in a full
 * run, while a no-op file governs it in a lone run. Both green, both different.
 *
 * ── THE SHAPE THIS FIXES IT WITH ────────────────────────────────────────────
 * `env` and `getRequest` are per-file ARGUMENTS because they are call-time
 * seams, and are therefore order-safe by mechanism — a test may legitimately
 * want its own request headers or its own env.
 *
 * The `createServerFn` fake takes **no options, on purpose.** It is the
 * eval-time capture, so any option that changed its semantics would put the
 * hazard straight back the first time someone passed a different argument. If
 * you find yourself wanting one, that is the bug reappearing, not a gap.
 *
 * It is FAITHFUL: it runs `.validator()`, per server function. Production runs
 * the validator, and a fake that skips it lets tests pass inputs the real route
 * would refuse. Per-function state matters too — the previous component-test
 * copies shared one `api` object across every `createServerFn()` call, which
 * with a running validator would mean the last `.validator()` registered in a
 * module applied to every function in it.
 *
 * Two tripwires fail if this regresses: one in `gateway.test.ts` (route-level
 * normalization) and one in `workspace-select.test.ts` (a strict-schema
 * refusal). If either goes red, fix the fake — never the tripwire.
 *
 * ── THE ONE CAVEAT ──────────────────────────────────────────────────────────
 * This holds only while every `env` read in `src/` stays INSIDE a function,
 * which is true today. A top-level `env` read would become an eval-time
 * capture like the others, and would freeze the first file's env object for
 * the whole suite.
 */
export function installServerFnMocks(opts: {
  /** Stands in for the Workers `env`. Read at call time, so per-file is safe. */
  env: object;
  /** The server-function request. Defaults to an empty-headers localhost GET. */
  getRequest?: () => Request;
}): void {
  const getRequest =
    opts.getRequest ?? (() => new Request("http://localhost:3000/", { headers: new Headers() }));

  mock.module("cloudflare:workers", () => ({ env: opts.env }));

  mock.module("@tanstack/react-start/server", () => ({ getRequest }));

  mock.module("@tanstack/react-start", () => ({
    createServerFn: (_opts?: unknown) => {
      // Per server function, never shared: each one owns its own validator.
      let validate: ((input: unknown) => unknown) | undefined;
      const api = {
        validator(v: (input: unknown) => unknown) {
          validate = v;
          return api;
        },
        handler(fn: (ctx: { data: unknown }) => unknown) {
          return (arg?: { data?: unknown }) =>
            fn({ data: validate ? validate(arg?.data) : arg?.data });
        },
      };
      return api;
    },
  }));
}
