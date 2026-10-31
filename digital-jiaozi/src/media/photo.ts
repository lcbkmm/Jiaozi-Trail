import { JiaoziError } from '../domain/types.ts';
import type { Photo } from '../domain/types.ts';
import type { Crop } from './crop.ts';

export function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try { canvas.toBlob(blob => blob ? resolve(blob) : reject(new JiaoziError('IMAGE_EXPORT', '浏览器未能生成图片，请缩小图片后重试。')), 'image/png'); }
    catch { reject(new JiaoziError('IMAGE_EXPORT', '图片无法导出，请检查素材跨域权限或使用本站图片。')); }
  });
}
export async function decode(blob: Blob): Promise<ImageBitmap> {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch { throw new JiaoziError('IMAGE_DECODE', '无法读取这张图片，请使用 JPEG、PNG 或 WebP；HEIC 可先导出为 JPEG。'); }
}
export async function normalizePhoto(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  if (file.size > 15 * 1024 * 1024) throw new JiaoziError('IMAGE_SIZE', '照片不能超过 15 MB');
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const jpeg = header[0] === 255 && header[1] === 216;
  const png = header[0] === 137 && header[1] === 80 && header[2] === 78 && header[3] === 71;
  const webp = new TextDecoder().decode(header.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(header.slice(8, 12)) === 'WEBP';
  if (!jpeg && !png && !webp) throw new JiaoziError('IMAGE_FORMAT', '请选择 JPEG、PNG 或 WebP 照片');
  const image = await decode(file);
  try {
    if (image.width * image.height > 24_000_000 || Math.min(image.width, image.height) < 8) throw new JiaoziError('IMAGE_PIXELS', '照片须在 8 像素至 2400 万像素之间');
    const scale = Math.min(1, 2048 / Math.max(image.width, image.height)), canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
    const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { blob: await canvasBlob(canvas), width: canvas.width, height: canvas.height };
  } finally { image.close(); }
}
export async function rotatePhoto(blob: Blob) {
  const image = await decode(blob);
  try {
    const canvas = document.createElement('canvas'); canvas.width = image.height; canvas.height = image.width;
    const ctx = canvas.getContext('2d')!; ctx.translate(canvas.width / 2, canvas.height / 2); ctx.rotate(Math.PI / 2);
    ctx.drawImage(image, -image.width / 2, -image.height / 2); return { blob: await canvasBlob(canvas), width: canvas.width, height: canvas.height };
  } finally { image.close(); }
}
export async function renderPhoto(blob: Blob, crop: Crop, mode: Photo['mode'], threshold = 140): Promise<Blob> {
  const image = await decode(blob);
  try {
    const side = Math.round(Math.min(image.width, image.height) * crop.size), x = Math.round(image.width * crop.x), y = Math.round(image.height * crop.y);
    if (![x, y, side].every(Number.isFinite) || side < 8 || x < 0 || y < 0 || x + side > image.width || y + side > image.height) throw new JiaoziError('CROP_INVALID', '裁剪框超出了照片范围');
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!; ctx.drawImage(image, x, y, side, side, 0, 0, 512, 512);
    if (mode !== 'color') {
      const pixels = ctx.getImageData(0, 0, 512, 512), original = new Uint8ClampedArray(pixels.data);
      const grey = (i: number) => (original[i] * .299 + original[i + 1] * .587 + original[i + 2] * .114);
      for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
        const i = (y * 512 + x) * 4;
        const value = mode === 'tone' ? Math.max(0, Math.min(1, (threshold - grey(i)) / 20 + .5)) : Math.min(1, Math.abs(grey(i) - grey((y * 512 + Math.max(0, x - 1)) * 4)) / Math.max(4, (255 - threshold) / 8) + Math.abs(grey(i) - grey((Math.max(0, y - 1) * 512 + x) * 4)) / 16);
        pixels.data[i] = 180; pixels.data[i + 1] = 76; pixels.data[i + 2] = 51; pixels.data[i + 3] = Math.round(value * original[i + 3]);
      }
      ctx.putImageData(pixels, 0, 0);
    }
    return await canvasBlob(canvas);
  } finally { image.close(); }
}
