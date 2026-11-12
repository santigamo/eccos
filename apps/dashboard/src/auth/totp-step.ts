/**
 * A TOTP code is good for three time-steps (Better Auth accepts one either
 * side of now), and Better Auth keeps no record of the one it accepted. This
 * claims the step a just-accepted code belongs to, on the `twoFactor` row, so
 * that code, or an older one, is never accepted for step-up again.
 */

import { symmetricDecrypt } from "better-auth/crypto";

interface Where {
  field: string;
  value: string | number;
  operator?: "lt";
}

/** The slice of Better Auth's context this needs, in hooks and server functions alike. */
interface TotpContext {
  adapter: {
    findOne(query: { model: string; where: Where[] }): Promise<unknown>;
    update(query: { model: string; where: Where[]; update: Record<string, unknown> }): Promise<unknown>;
  };
  getPlugin(id: string): unknown;
  secretConfig: Parameters<typeof symmetricDecrypt>[0]["key"];
}

const DEFAULT_PERIOD_SECONDS = 30;
const DEFAULT_DIGITS = 6;

/** RFC 4226, as Better Auth computes it: the secret's UTF-8 bytes are the key. */
async function hotp(secret: string, counter: number, digits: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const message = new DataView(new ArrayBuffer(8));
  message.setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const at = (mac.at(-1) ?? 0) & 15;
  const word = new DataView(mac.buffer).getUint32(at) & 0x7fffffff;
  return (word % 10 ** digits).toString().padStart(digits, "0");
}

/**
 * True when `code` belongs to a step newer than any claimed before, which is
 * now claimed. One conditional write, so the same code presented twice at
 * once is claimed once. False for a used or older code, or one that matches
 * no step at all.
 */
export async function claimTotpStep(
  context: TotpContext,
  userId: string,
  code: string,
): Promise<boolean> {
  const factor = (await context.adapter.findOne({
    model: "twoFactor",
    where: [{ field: "userId", value: userId }],
  })) as { id: string; secret: string } | null;
  if (!factor) return false;
  const plugin = context.getPlugin("two-factor") as
    | { options?: { totpOptions?: { period?: number; digits?: number } } }
    | null
    | undefined;
  const options = plugin?.options?.totpOptions;
  const digits = options?.digits ?? DEFAULT_DIGITS;
  const now = Math.floor(Date.now() / ((options?.period ?? DEFAULT_PERIOD_SECONDS) * 1000));
  const secret = await symmetricDecrypt({ key: context.secretConfig, data: factor.secret });
  for (const step of [now + 1, now, now - 1]) {
    if ((await hotp(secret, step, digits)) !== code) continue;
    const claimed = await context.adapter.update({
      model: "twoFactor",
      where: [
        { field: "id", value: factor.id },
        { field: "lastTotpStep", operator: "lt", value: step },
      ],
      update: { lastTotpStep: step },
    });
    return Boolean(claimed);
  }
  return false;
}
