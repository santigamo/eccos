/**
 * How long a definition, or the absence of one, is trusted. The gateway drops a template when it
 * edits or deletes it itself; an edit made in Meta Business Manager is only seen once the entry
 * expires, so sends in the next five minutes may still record the previous copy.
 */
const TTL_MS = 5 * 60 * 1000;

type Load = (name: string, language: string) => Promise<unknown[] | null>;

/**
 * Template definitions (Meta's `components`) by name and language. Concurrent reads of one template
 * share one load, and a miss is kept as long as a hit: a broadcast whose lookup fails must not
 * repeat it for every recipient and spend the WABA's template rate limit.
 */
export class TemplateDefinitions {
  private entries = new Map<string, { name: string; at: number; components: Promise<unknown[] | null> }>();

  constructor(private load: Load) {}

  get(name: string, language: string): Promise<unknown[] | null> {
    const key = `${name}\n${language}`;
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.components;
    const components = this.load(name, language).catch(() => null);
    this.entries.set(key, { name, at: Date.now(), components });
    return components;
  }

  /** Drops every language of a template. */
  forget(name: string): void {
    for (const [key, entry] of this.entries) if (entry.name === name) this.entries.delete(key);
  }
}
