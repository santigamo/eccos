import { z } from "zod";
import { coreSchema, graphBaseUrl as coreGraphBaseUrl } from "@eccos/core/config-schema";

const bunSchema = coreSchema.extend({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_PATH: z.string().min(1).default("./data/eccos.db"),
});
export type Config = z.infer<typeof bunSchema>;
export const graphBaseUrl = coreGraphBaseUrl;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    cleaned[key] = typeof value === "string" && value.trim() === "" ? undefined : value;
  }
  const parsed = bunSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid Eccos configuration:\n${issues}`);
  }
  return parsed.data;
}
