/**
 * The Eccos API requests the console prints for a developer to copy: the
 * workspace's WABA and the gateway origin filled in when known. The API key is
 * a placeholder unless one was just issued; the console never holds it after.
 */

export type CurlInput = {
  method: "POST" | "PUT" | "DELETE";
  url: string;
  apiKey?: string;
  headers?: string[];
  /** JSON text, already laid out. */
  body?: string;
};

/** One flag per line, the house layout. */
export function curlCommand({ method, url, apiKey, headers = [], body }: CurlInput): string {
  const lines = [`curl -X ${method} ${url}`, `-H "Authorization: Bearer ${apiKey ?? "<API_KEY>"}"`];
  if (body !== undefined) lines.push(`-H "Content-Type: application/json"`);
  for (const header of headers) lines.push(`-H "${header}"`);
  if (body !== undefined) lines.push(`-d '${body}'`);
  return lines.join(" \\\n  ");
}

/** `/v1/wabas/{wabaId}` plus `path`, with a placeholder while the WABA is unknown. */
export function wabaPath(wabaId: string | undefined, path: string): string {
  return `/v1/wabas/${wabaId ?? "<WABA_ID>"}${path}`;
}

export function gatewayUrl(origin: string | null | undefined, path: string): string {
  return `${origin ?? "<GATEWAY_URL>"}${path}`;
}

/** A broadcast to one recipient, the shape a list of them takes. */
export function broadcastCurl(wabaId: string | undefined, origin: string | null | undefined): string {
  return curlCommand({
    method: "POST",
    url: gatewayUrl(origin, wabaPath(wabaId, "/broadcasts")),
    headers: ["Idempotency-Key: order-ready-001"],
    body: `{
    "template": { "name": "order_ready", "language": { "code": "es" } },
    "recipients": [
      { "to": "34600111222", "components": [{ "type": "body", "parameters": [
          { "type": "text", "text": "Ana" }, { "type": "text", "text": "viernes" }] }] }
    ]
  }`,
  });
}

/** A scheduled send under the key `appt-8812`, at `sendAt` (ISO 8601 with its offset). */
export function scheduledCurl(wabaId: string | undefined, origin: string | null | undefined, sendAt: string): string {
  return curlCommand({
    method: "PUT",
    url: gatewayUrl(origin, wabaPath(wabaId, "/scheduled/appt-8812")),
    body: `{
    "to": "34600111222",
    "template": { "name": "appointment_reminder", "language": { "code": "es" },
      "components": [{ "type": "body", "parameters": [
        { "type": "text", "text": "Ana" }, { "type": "text", "text": "13:30" }] }] },
    "sendAt": "${sendAt}"
  }`,
  });
}

/** Tomorrow at 09:00 in the zone of `now`'s runtime, with its UTC offset: valid as pasted. */
export function tomorrowAtNine(now: Date): string {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0);
  const offset = -at.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${date}T09:00:00${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}
