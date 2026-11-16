/** A template's words as the customer received them: the copy with the send's parameters filled in. */
export interface TemplateCopy {
  header?: string;
  body: string;
  footer?: string;
  buttons?: string[];
}

type Json = Record<string, unknown>;

/**
 * Fills a template definition (Meta's `components`, as `message_templates` returns them) with the
 * parameters of one send (the send body's `template.components`). `{{1}}` takes the component's
 * n-th parameter, `{{name}}` the parameter with that `parameter_name`; a placeholder the send does
 * not fill stays as written. Null when the definition has no body text.
 */
export function fillTemplate(definition: unknown, sent: unknown): TemplateCopy | null {
  const defined = records(definition);
  const textOf = (type: string) => {
    const component = defined.find((c) => upper(c.type) === type);
    return typeof component?.text === "string" && component.text !== "" ? component : null;
  };
  const body = textOf("BODY");
  if (!body) return null;
  const params = (type: string) => records(records(sent).find((c) => upper(c.type) === type)?.parameters);

  const copy: TemplateCopy = { body: fill(String(body.text), params("BODY")) };
  const header = textOf("HEADER");
  if (header && (header.format === undefined || upper(header.format) === "TEXT")) {
    copy.header = fill(String(header.text), params("HEADER"));
  }
  const footer = textOf("FOOTER");
  if (footer) copy.footer = String(footer.text);
  const buttons = records(defined.find((c) => upper(c.type) === "BUTTONS")?.buttons)
    .map((button) => button.text)
    .filter((text): text is string => typeof text === "string" && text !== "");
  if (buttons.length > 0) copy.buttons = buttons;
  return copy;
}

function fill(text: string, params: Json[]): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (placeholder, key: string) => {
    const param = /^\d+$/.test(key) ? params[Number(key) - 1] : params.find((p) => p.parameter_name === key);
    return (param && paramText(param)) ?? placeholder;
  });
}

/** A text parameter's text, or the `fallback_value` a currency or date_time parameter carries. */
function paramText(param: Json): string | null {
  if (typeof param.text === "string") return param.text;
  const inner = param[String(param.type)];
  const fallback = typeof inner === "object" && inner !== null ? (inner as Json).fallback_value : undefined;
  return typeof fallback === "string" ? fallback : null;
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((v): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)) : [];
}

function upper(value: unknown): string {
  return typeof value === "string" ? value.toUpperCase() : "";
}
