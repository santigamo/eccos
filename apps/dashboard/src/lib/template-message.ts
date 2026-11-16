import type { TemplateCopy } from "@eccos/core/template-copy";
import type { MessageRecord } from "../server/gateway";
import { contentOf } from "./conversations";
import { type RequestValue, templateReading } from "./logs";

/**
 * A sent template as the thread reads it. `copy` is what the customer read, stored by the gateway
 * at send time; without it (older rows, a failed lookup) only the name and the values sent are known,
 * and nothing is drawn from the template as it stands today (DASHBOARD-DESIGN data rule 10).
 */
export interface TemplateMessage {
  name: string | null;
  copy: TemplateCopy | null;
  values: RequestValue[];
}

export function templateMessageOf(message: MessageRecord): TemplateMessage {
  const content = contentOf(message);
  const reading = templateReading(content);
  return { name: reading.template?.name ?? null, copy: copyOf(content.copy), values: reading.values };
}

function copyOf(value: unknown): TemplateCopy | null {
  if (typeof value !== "object" || value === null) return null;
  const { header, body, footer, buttons } = value as Record<string, unknown>;
  if (typeof body !== "string") return null;
  const labels = Array.isArray(buttons) ? buttons.filter((b): b is string => typeof b === "string") : [];
  return {
    body,
    ...(typeof header === "string" ? { header } : {}),
    ...(typeof footer === "string" ? { footer } : {}),
    ...(labels.length > 0 ? { buttons: labels } : {}),
  };
}
