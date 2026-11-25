// Prints the current 6-digit TOTP code (RFC 6238, SHA-1, 30 s) for an otpauth:// URI or a
// base32 secret, so the helper can enroll and step up without an authenticator app.
import { createHmac } from "node:crypto";

const arg = process.argv[2];
if (!arg) throw new Error("usage: totp.ts <otpauth URI | base32 secret>");
const secret = arg.startsWith("otpauth:") ? new URL(arg).searchParams.get("secret") ?? "" : arg;

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
let bits = "";
for (const char of secret.replace(/=+$/, "").toUpperCase()) {
  const value = alphabet.indexOf(char);
  if (value < 0) throw new Error("the secret is not base32");
  bits += value.toString(2).padStart(5, "0");
}
const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));

const counter = Buffer.alloc(8);
counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
const hmac = createHmac("sha1", key).update(counter).digest();
const offset = (hmac.at(-1) ?? 0) & 0xf;
console.log(String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0"));
