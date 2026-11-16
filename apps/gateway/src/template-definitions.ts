const TTL_MS = 60 * 60 * 1000;

type Load = (name: string, language: string) => Promise<unknown[] | null>;

/**
 * Template definitions (Meta's `components`) by name and language, kept for an hour. Concurrent
 * reads of one template share one load, so a broadcast batch reads it once. A failed or empty load
 * is not kept: the next send asks again.
 */
export class TemplateDefinitions {
  private entries = new Map<string, { at: number; components: Promise<unknown[] | null> }>();

  constructor(
    private load: Load,
    private now: () => number = Date.now,
  ) {}

  get(name: string, language: string): Promise<unknown[] | null> {
    const key = `${name}\n${language}`;
    const hit = this.entries.get(key);
    if (hit && this.now() - hit.at < TTL_MS) return hit.components;
    const entry = { at: this.now(), components: this.load(name, language).catch(() => null) };
    this.entries.set(key, entry);
    void entry.components.then((components) => {
      if (components === null && this.entries.get(key) === entry) this.entries.delete(key);
    });
    return entry.components;
  }
}
