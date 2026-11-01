import { JiaoziError } from '../domain/types.ts';
import { decode } from './photo.ts';

/** Validate content, not just an extension. Also used before a repository write. */
export async function validateCheckinPhoto(blob: Blob) {
  if (!(blob instanceof Blob) || !blob.size) throw new JiaoziError('IMAGE_EMPTY', '请先拍摄或选择一张照片。');
  if (blob.size > 15 * 1024 * 1024) throw new JiaoziError('IMAGE_SIZE', '照片不能超过 15 MB，请选择小一些的照片。');
  const h = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const jpeg = h[0] === 255 && h[1] === 216 && h[2] === 255;
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => h[i] === b);
  const webp = new TextDecoder().decode(h.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(h.slice(8, 12)) === 'WEBP';
  if (!jpeg && !png && !webp) throw new JiaoziError('IMAGE_FORMAT', '请选择 JPEG、PNG 或 WebP 照片。');
}

/** Keep the complete composition and orientation; resize only to save local storage. */
export async function prepareCheckinPhoto(file: Blob): Promise<Blob> {
  await validateCheckinPhoto(file);
  const image = await decode(file);
  try {
    if (Math.min(image.width, image.height) < 8 || image.width * image.height > 48_000_000) throw new JiaoziError('IMAGE_PIXELS', '照片尺寸不合适，请选择 8 像素至 4800 万像素的照片。');
    const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new JiaoziError('IMAGE_DECODE', '当前浏览器无法处理照片，请换个浏览器重试。');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new JiaoziError('IMAGE_EXPORT', '照片保存失败，请重新选择。')), 'image/jpeg', .86));
  } finally { image.close(); }
}
