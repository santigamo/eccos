import {
  buildSendComponents,
  MAX_BODY_PARAM_LENGTH,
  templateVariables,
  validateTemplateSend,
  type TemplateRow,
} from "@eccos/core/template-rules";
import type { CreateBroadcastInput, CreateBroadcastResult } from "@eccos/gateway-contract";

type Refusal = Extract<CreateBroadcastResult, { ok: false }>;

const VALUE_ERROR = "every value must be 1-1024 characters on one line";
const MAX_INVALID = 100;

function validValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_BODY_PARAM_LENGTH && !/[\n\t]/.test(value);
}

const sameKeys = (a: string[], b: string[]) =>
  a.length === b.length && new Set(a).size === a.length && a.every((key) => b.includes(key));

const columnId = (column: CreateBroadcastInput["columns"][number]) =>
  column.kind === "body" ? `body:${column.key}` : `button:${column.index}`;

/**
 * The `POST /broadcasts` body a console broadcast stands for, built against the
 * template as Meta stores it now: the columns must be exactly its variables, and
 * every recipient's components are built here, never taken from the caller.
 */
export function broadcastBody(
  input: CreateBroadcastInput,
  template: TemplateRow,
): { ok: true; body: Record<string, unknown> } | Refusal {
  const vars = templateVariables(template);
  if ("unsupported" in vars) return { ok: false, code: "template_unsupported", detail: vars.unsupported };

  const columns = Array.isArray(input.columns) ? input.columns : [];
  const bodyKeys = columns.flatMap((column) => (column?.kind === "body" ? [String(column.key)] : []));
  const buttonKeys = columns.flatMap((column) => (column?.kind === "button" ? [String(column.index)] : []));
  const mismatch =
    bodyKeys.length + buttonKeys.length !== columns.length ||
    !sameKeys(bodyKeys, vars.body.map((variable) => variable.key)) ||
    !sameKeys(buttonKeys, vars.buttons.map((slot) => String(slot.index))) ||
    (vars.headerMedia ?? null) !== (input.headerMedia?.format ?? null);
  if (mismatch) {
    return { ok: false, code: "parameter_mismatch", detail: "the columns do not match the template's variables" };
  }

  let headerMedia: ReturnType<typeof validateTemplateSend>["headerMedia"];
  try {
    ({ headerMedia } = validateTemplateSend({
      templateName: input.templateName,
      languageCode: input.languageCode,
      headerMedia: input.headerMedia,
    }));
  } catch (error) {
    return { ok: false, code: "invalid_request", detail: error instanceof Error ? error.message : "invalid request" };
  }
  if (columns.some((column) => column.fixed !== undefined && !validValue(column.fixed))) {
    return { ok: false, code: "invalid_request", detail: VALUE_ERROR };
  }

  const perRow = columns.filter((column) => column.fixed === undefined);
  const position = new Map(columns.map((column, i) => [columnId(column), i]));
  const components = (values: string[]) => {
    let next = 0;
    const filled = columns.map((column) => (column.fixed ?? values[next++] ?? "").trim());
    const cell = (id: string) => filled[position.get(id) ?? -1] ?? "";
    return buildSendComponents({
      body:
        vars.format === "named"
          ? Object.fromEntries(vars.body.map(({ key }) => [key, cell(`body:${key}`)]))
          : vars.body.map(({ key }) => cell(`body:${key}`)),
      buttons: vars.buttons.map((slot) => ({
        index: slot.index,
        text: cell(`button:${slot.index}`),
        ...(slot.parameterName ? { parameterName: slot.parameterName } : {}),
      })),
      ...(headerMedia ? { headerMedia } : {}),
    });
  };

  const recipients = Array.isArray(input.recipients) ? input.recipients : [];
  const invalid: { index: number; error: string }[] = [];
  recipients.forEach((recipient, index) => {
    const values = recipient?.values;
    if (!Array.isArray(values) || values.length !== perRow.length || !values.every(validValue)) {
      invalid.push({ index, error: VALUE_ERROR });
    }
  });
  if (invalid.length > 0) {
    return { ok: false, code: "invalid_recipients", detail: VALUE_ERROR, invalid: invalid.slice(0, MAX_INVALID) };
  }

  const shared = perRow.length === 0 ? components([]) : null;
  return {
    ok: true,
    body: {
      template: {
        name: input.templateName,
        language: input.languageCode,
        ...(shared && shared.length > 0 ? { components: shared } : {}),
      },
      ...(input.label !== undefined ? { label: input.label } : {}),
      recipients: recipients.map((recipient) => ({
        to: recipient.to,
        ...(shared ? {} : { components: components(recipient.values) }),
      })),
    },
  };
}
