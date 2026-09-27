import { ApiError } from './api.js';

// Read while the picker still owns its file handle. A File reference and size
// alone do not guarantee that Safari can later stream it after route changes.
export async function snapshotPhoto(file: File): Promise<Blob> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
  if (file.size > 5 * 1024 * 1024) throw new ApiError('FILE_TOO_LARGE');
  if (!file.size) throw new ApiError('PHOTO_REQUIRED');
  let bytes: ArrayBuffer;
  try { bytes = await file.arrayBuffer(); } catch { throw new ApiError('PHOTO_READ_FAILED'); }
  if (bytes.byteLength !== file.size) throw new ApiError('PHOTO_READ_FAILED');
  return new Blob([bytes], {type:file.type});
}

// Avoid WebKit's disk-backed File/FormData serializer: construct the complete,
// bounded multipart body as bytes. No original filename or EXIF is logged.
export async function encodePhotoUpload(form: FormData) {
  const version = form.get('expectedVersion'), photo = form.get('photo');
  if (typeof version !== 'string' || !/^\d+$/.test(version) || !Number.isSafeInteger(Number(version))) throw new ApiError('VALIDATION_ERROR');
  if (!(photo instanceof Blob) || !photo.size) throw new ApiError('PHOTO_REQUIRED');
  if (photo.size > 5 * 1024 * 1024) throw new ApiError('FILE_TOO_LARGE');
  if (!['image/png','image/jpeg','image/webp'].includes(photo.type)) throw new ApiError('UNSUPPORTED_MEDIA_TYPE');
  const bytes = new Uint8Array(await photo.arrayBuffer());
  if (bytes.byteLength !== photo.size) throw new ApiError('PHOTO_READ_FAILED');
  const boundary = `zkiss-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="expectedVersion"\r\n\r\n${version}\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="photo"\r\nContent-Type: ${photo.type}\r\n\r\n`);
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length+bytes.length+tail.length);
  body.set(head); body.set(bytes,head.length); body.set(tail,head.length+bytes.length);
  return {body,contentType:`multipart/form-data; boundary=${boundary}`};
}
