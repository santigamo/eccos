import { isBsuid } from "@eccos/core/bsuid";
import {
  LANGUAGE_PATTERN,
  MAX_BODY_PARAM_LENGTH,
  TEMPLATE_NAME_PATTERN,
} from "@eccos/core/template-rules";
import type {
  BroadcastColumn,
  CreateBroadcastInput,
} from "@eccos/gateway-contract";
import { MAX_BROADCAST_BYTES } from "../lib/broadcast-draft";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f-]{36}$/i;
const DIGITS = /^[0-9]{5,15}$/;
const MAX_COLUMNS = 33;
/** A shape bound only: the gateway holds the real limit and the console reads it from the preflight. */
const MAX_RECIPIENTS = 10_000;

function text(
  value: unknown,
  what: string,
  max = MAX_BODY_PARAM_LENGTH,
): string {
  if (typeof value !== "string" || value.length > max)
    throw new Error(`invalid ${what}`);
  return value;
}

function column(value: unknown): BroadcastColumn {
  const entry = value as Record<string, unknown> | null;
  if (!entry || typeof entry !== "object") throw new Error("invalid column");
  const fixed =
    entry.fixed === undefined ? {} : { fixed: text(entry.fixed, "value") };
  if (entry.kind === "body")
    return { kind: "body", key: text(entry.key, "column", 128), ...fixed };
  if (entry.kind === "button" && Number.isInteger(entry.index))
    return { kind: "button", index: Number(entry.index), ...fixed };
  throw new Error("invalid column");
}

/**
 * The console's broadcast, checked before it crosses the binding: shapes and a
 * byte ceiling only. The template rules are the gateway's, against the live template.
 * Recipients and values never reach a log from here.
 */
export function validateCreateBroadcastInput(
  input: unknown,
): CreateBroadcastInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("invalid dashboard request");
  if (JSON.stringify(input).length > MAX_BROADCAST_BYTES)
    throw new Error("this list is too large for one broadcast");
  const record = input as Record<string, unknown>;
  if (typeof record.wabaId !== "string" || !ID.test(record.wabaId))
    throw new Error("wabaId is required");
  if (
    typeof record.phoneNumberId !== "string" ||
    !ID.test(record.phoneNumberId)
  )
    throw new Error("phoneNumberId is required");
  if (
    typeof record.templateName !== "string" ||
    !TEMPLATE_NAME_PATTERN.test(record.templateName)
  ) {
    throw new Error("invalid template name");
  }
  if (
    typeof record.languageCode !== "string" ||
    !LANGUAGE_PATTERN.test(record.languageCode)
  ) {
    throw new Error("invalid template language");
  }
  if (
    typeof record.idempotencyKey !== "string" ||
    !UUID.test(record.idempotencyKey)
  )
    throw new Error("invalid idempotency key");
  const label =
    record.label === undefined
      ? undefined
      : text(record.label, "label", 80).trim();
  if (label === "") throw new Error("invalid label");
  if (!Array.isArray(record.columns) || record.columns.length > MAX_COLUMNS)
    throw new Error("invalid columns");
  const columns = record.columns.map(column);
  const media = record.headerMedia as Record<string, unknown> | undefined;
  const headerMedia =
    media === undefined
      ? undefined
      : {
          format: text(media?.format, "header", 16) as
            | "image"
            | "video"
            | "document",
          link: text(media?.link, "header link", 2048),
        };
  if (
    !Array.isArray(record.recipients) ||
    record.recipients.length === 0 ||
    record.recipients.length > MAX_RECIPIENTS
  ) {
    throw new Error("invalid recipients");
  }
  const recipients = record.recipients.map((value) => {
    const entry = value as Record<string, unknown> | null;
    const to = entry?.to;
    if (typeof to !== "string" || !(DIGITS.test(to) || isBsuid(to)))
      throw new Error("invalid recipient");
    if (!Array.isArray(entry?.values))
      throw new Error("invalid recipient values");
    return { to, values: entry.values.map((cell) => text(cell, "value")) };
  });
  return {
    wabaId: record.wabaId,
    phoneNumberId: record.phoneNumberId,
    templateName: record.templateName,
    languageCode: record.languageCode,
    ...(label ? { label } : {}),
    columns,
    ...(headerMedia ? { headerMedia } : {}),
    recipients,
    idempotencyKey: record.idempotencyKey,
  };
}
