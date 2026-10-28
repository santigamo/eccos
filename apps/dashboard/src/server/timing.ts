/**
 * Request-scoped stage timings, surfaced as `Server-Timing` and one `perf` log
 * line. Keyed by the Request's Headers object (like auth/request-memo.ts) so
 * the auth layer, the gateway seam and the server entry share one record with
 * no plumbing. Stage names and durations only — never ids, tokens or payloads.
 */

interface Stage {
  ms: number;
  n: number;
}

interface Timing {
  start: number;
  stages: Map<string, Stage>;
}

const byRequest = new WeakMap<object, Timing>();

const now = () => performance.now();
const round = (ms: number) => Math.round(ms * 10) / 10;

export function beginTiming(request: Request): void {
  byRequest.set(request.headers, { start: now(), stages: new Map() });
}

/** Run `fn`, recording its duration under `name` for the request `key` (Headers or Request). */
export async function timed<T>(key: unknown, name: string, fn: () => Promise<T>): Promise<T> {
  const headers = key instanceof Request ? key.headers : key;
  const timing = typeof headers === "object" && headers ? byRequest.get(headers) : undefined;
  if (!timing) return fn();
  const t0 = now();
  try {
    return await fn();
  } finally {
    const stage = timing.stages.get(name) ?? { ms: 0, n: 0 };
    stage.ms += now() - t0;
    stage.n += 1;
    timing.stages.set(name, stage);
  }
}

/** Count an event under `name` for the request `key` (Headers or Request) without timing it. */
export function count(key: unknown, name: string): void {
  const headers = key instanceof Request ? key.headers : key;
  const timing = typeof headers === "object" && headers ? byRequest.get(headers) : undefined;
  if (!timing) return;
  const stage = timing.stages.get(name) ?? { ms: 0, n: 0 };
  stage.n += 1;
  timing.stages.set(name, stage);
}

export interface TimingReport {
  header: string;
  total: number;
  stages: Record<string, number>;
  /** Only stages that ran more than once. */
  counts: Record<string, number>;
}

export function finishTiming(request: Request): TimingReport | null {
  const timing = byRequest.get(request.headers);
  if (!timing) return null;
  byRequest.delete(request.headers);
  const total = round(now() - timing.start);
  const stages: Record<string, number> = {};
  const counts: Record<string, number> = {};
  const parts: string[] = [];
  for (const [name, { ms, n }] of timing.stages) {
    const token = name.replace(/[^A-Za-z0-9_-]/g, "_");
    stages[token] = round(ms);
    if (n > 1) counts[token] = n;
    parts.push(`${token};dur=${round(ms)}${n > 1 ? `;desc="${n}x"` : ""}`);
  }
  parts.push(`total;dur=${total}`);
  return { header: parts.join(", "), total, stages, counts };
}

export function logPerf(path: string, status: number, report: TimingReport): void {
  console.info(
    JSON.stringify({
      level: "info",
      area: "perf",
      fn: path,
      status,
      total: report.total,
      stages: report.stages,
      counts: report.counts,
    }),
  );
}

/** Wrap every function-valued property of `target` so each call is timed as `${prefix}${prop}`. */
export function timedProxy<T extends object>(key: unknown, target: T, prefix: string): T {
  return new Proxy(target, {
    get(obj, prop) {
      const value = Reflect.get(obj, prop, obj);
      if (typeof prop !== "string" || prop === "then" || typeof value !== "function") return value;
      return (...args: unknown[]) =>
        timed(key, prefix + prop, async () => (value as (...a: unknown[]) => unknown).apply(obj, args));
    },
  });
}
