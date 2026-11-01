import type { Landmark } from '../config/landmarks.ts';
export function assetUrl(path: string, base: string): string {
  const url = new URL(path, base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('素材必须为网站 HTTP(S) 地址');
  return url.href;
}
export function fallbackImage(color = '#95734e'): string {
  const safe = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#95734e';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="450"><rect width="600" height="450" rx="20" fill="#f2eadb"/><path d="M110 320h380v20H110zM150 310V190h110v120zm140 0V110h90v200zm120 0V160h50v150z" fill="${safe}"/><text x="300" y="392" text-anchor="middle" font-size="25" fill="${safe}">图片暂不可用</text></svg>`);
}
export async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image(); img.crossOrigin = 'anonymous'; img.onload = () => resolve(img); img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}
export function landmarkSource(landmark: Pick<Landmark, 'image' | 'color'>, base: string) {
  try { return assetUrl(landmark.image, base); } catch { return fallbackImage(landmark.color); }
}
