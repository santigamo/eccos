import {
  createStartHandler,
  defaultStreamHandler,
} from "@tanstack/react-start/server";
import { createServerEntry, type ServerEntry } from "@tanstack/react-start/server-entry";
import { env } from "cloudflare:workers";
import { enforceAccess } from "./access";

/**
 * Custom TanStack Start server entry (picked up by convention at `src/server.ts`,
 * and pointed at by `wrangler.jsonc` `main`).
 *
 * It wraps the default SSR + server-function fetch handler with the Cloudflare
 * Access gate so verification runs on EVERY request — page loads, server routes,
 * and server-function calls alike — before anything is routed. `env` is read
 * per-request inside the handler (the `cloudflare:workers` binding proxy is only
 * valid within a request scope), never at module top level.
 */
const startHandler = createStartHandler(defaultStreamHandler);

const handleFetch: ServerEntry["fetch"] = async (request, opts) => {
  const blocked = await enforceAccess(request, env);
  if (blocked) return blocked;
  return startHandler(request, opts);
};

export default createServerEntry({ fetch: handleFetch });
