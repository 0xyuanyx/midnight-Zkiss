import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { fail } from "./http.js";
/** Session-bound opaque cursor; hides the global outbox sequence and rejects tampering. */
export function encodeCursor(sequence: string, secret: string) {
  const iv = randomBytes(12),
    key = createHash("sha256").update(secret).digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(sequence, "utf8"), cipher.final()]);
  return (
    "c1." + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url")
  );
}
export function decodeCursor(cursor: string, secret: string) {
  if (cursor === "0") return "0";
  try {
    if (!/^c1\.[A-Za-z0-9_-]{38,100}$/.test(cursor)) throw new Error();
    const data = Buffer.from(cursor.slice(3), "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      createHash("sha256").update(secret).digest(),
      data.subarray(0, 12),
    );
    decipher.setAuthTag(data.subarray(12, 28));
    const sequence = Buffer.concat([
      decipher.update(data.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
    if (!/^\d{1,19}$/.test(sequence) || BigInt(sequence) > 9223372036854775807n)
      throw new Error();
    return sequence;
  } catch {
    fail(422, "INVALID_CURSOR");
  }
}
