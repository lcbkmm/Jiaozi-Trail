import type { FocusCrop, PanelCrop } from './types.ts';
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
export function photoRegion(width: number, height: number, crop: FocusCrop) {
  if (![width, height, crop.x, crop.y, crop.zoom].every(Number.isFinite) || width < 3 || height < 2 || crop.zoom < 1 || crop.zoom > 4) throw new Error('照片裁切参数无效');
  const w = Math.min(width, height * 1.5) / crop.zoom, h = w / 1.5;
  return { x: (width - w) * clamp(crop.x, 0, 1), y: (height - h) * clamp(crop.y, 0, 1), width: w, height: h };
}
export function posterSize(width: number, height: number) {
  const w = 3 * Math.floor(Math.min(1536, width, height * 1.5) / 3);
  if (!Number.isFinite(w) || w < 3) throw new Error('裁切区域太小，无法导出海报');
  return { width: w, height: w * 4 / 3 };
}
export function panelRegion(width: number, height: number, crop: PanelCrop) {
  if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) || crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || crop.x + crop.width > 1.00001 || crop.y + crop.height > 1.00001) throw new Error('生成图裁切范围无效');
  return { x: crop.x * width, y: crop.y * height, width: crop.width * width, height: crop.height * height };
}
