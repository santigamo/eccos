import { relative } from "node:path";
import type { Reporter, TestModule } from "vitest/node";

/**
 * Fails the run when Vitest stops making progress. A file whose worker never reports back hangs
 * the run with no error and no timeout (eccos-yjnq), so CI would sit until its job limit.
 */
export class StallWatchdog implements Reporter {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly open = new Map<string, number>();
  private readonly ended: string[] = [];

  constructor(private readonly quietMs: number) {}

  onTestRunStart() {
    this.arm();
  }

  onTestModuleQueued(module: TestModule) {
    this.open.set(this.name(module), Date.now());
    this.arm();
  }

  onTestModuleStart() {
    this.arm();
  }

  onTestCaseResult() {
    this.arm();
  }

  onTestModuleEnd(module: TestModule) {
    this.open.delete(this.name(module));
    this.ended.push(this.name(module));
    this.arm();
  }

  onTestRunEnd() {
    clearTimeout(this.timer);
  }

  private name(module: TestModule) {
    return relative(process.cwd(), module.moduleId);
  }

  private arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stall(), this.quietMs);
    this.timer.unref();
  }

  private stall() {
    const running = [...this.open.keys()];
    const lines = [
      `\n[stall-watchdog] no test progress for ${this.quietMs / 1000}s; failing the run instead of hanging.`,
      running.length > 0
        ? `Files still running: ${running.join(", ")}`
        : "Every file reported its tests, but a worker never finished: some Vitest RPC from it was lost.",
      `Last files to finish: ${this.ended.slice(-5).join(", ") || "none"}`,
    ];
    process.stderr.write(`${lines.join("\n")}\n`);
    process.exit(1);
  }
}
