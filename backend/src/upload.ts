import type { FastifyRequest } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { fail, hash } from "./http.js";
export const uploads = new WeakMap<
  FastifyRequest,
  { bytes: Buffer; mime: string }
>();
export async function readUpload(req: FastifyRequest) {
  let bytes: Buffer | undefined,
    mime = "";
  const fields: Record<string, unknown> = {};
  try {
    for await (const part of req.parts()) {
      if (part.type === "file") {
        if (bytes || part.fieldname !== "photo") fail(422, "VALIDATION_ERROR");
        mime = part.mimetype;
        bytes = await part.toBuffer();
      } else {
        if (Object.hasOwn(fields, part.fieldname))
          fail(422, "VALIDATION_ERROR");
        fields[part.fieldname] = part.value;
      }
    }
    const parsed = z.object({ expectedVersion: z.coerce.number().int().min(0).safe() }).strict().parse(fields);
    if (!bytes || bytes.length === 0) fail(422, "PHOTO_REQUIRED");
    const valid =
      (mime === "image/png" &&
        bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
      (mime === "image/jpeg" &&
        bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) ||
      (mime === "image/webp" &&
        bytes.subarray(0, 4).toString() === "RIFF" &&
        bytes.subarray(8, 12).toString() === "WEBP");
    if (!valid) fail(415, "UNSUPPORTED_MEDIA_TYPE");
    try {
      const decoder = sharp(bytes, {
        limitInputPixels: 20_000_000,
        failOn: "warning",
      });
      const metadata = await decoder.metadata();
      if ((metadata.pages ?? 1) !== 1) fail(422, "INVALID_PHOTO");
      const pixels = await decoder.raw().toBuffer();
      pixels.fill(0);
      decoder.destroy();
    } catch {
      fail(422, "INVALID_PHOTO");
    }
    uploads.set(req, { bytes, mime });
    req.body = { ...parsed, photoHash: hash(bytes) };
    return () => {
      bytes!.fill(0);
      uploads.delete(req);
    };
  } catch (e) {
    bytes?.fill(0);
    throw e;
  }
}
