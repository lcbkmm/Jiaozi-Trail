import { canvasBlob, decode } from '../../media/photo.ts';
import { photoRegion, posterSize } from './geometry.ts';
import { renderPanel } from './panel-renderer.ts';
import type { MagnetWork } from './types.ts';
let fontReady: Promise<void> | undefined;
export function loadMagnetFont(assetBase: string) {
  return fontReady ||= (async () => {
    const font = new FontFace('DJMagnetTitle', `url("${new URL('assets/fonts/magnet-title.woff2', assetBase).href}")`);
    await font.load(); document.fonts.add(font);
  })().catch(() => { fontReady = undefined; throw new Error('海报字体加载失败，请检查本站字体资源后重试合成；生成原图仍可下载。'); });
}
export async function composePoster(work: MagnetWork, assetBase: string) {
  if (!work.panel) throw new Error('尚无生成原图');
  const title = [work.title.trim(), work.place.trim(), work.year.trim()].filter(Boolean).join(' · ');
  if (title) await loadMagnetFont(assetBase);
  const source = await decode(work.sourcePhoto);
  let panel: ImageBitmap | undefined;
  try {
    panel = await decode(work.panel.blob);
    const region = photoRegion(source.width, source.height, work.photoCrop), size = posterSize(region.width, region.height);
    const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('此浏览器无法创建海报画布');
    const half = size.height / 2;
    ctx.fillStyle = work.backgroundColor; ctx.fillRect(0, 0, size.width, half);
    renderPanel(ctx, panel, work.panelCrop, { x: size.width * .07, y: half * .06, width: size.width * .86, height: half * (title ? .72 : .88) });
    if (title) {
      const fontSize = Math.max(1, Math.round(size.width * .045));
      ctx.font = `${fontSize}px DJMagnetTitle`; ctx.fillStyle = '#30332f'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      let line = title; const maxWidth = size.width * .84;
      while (line.length > 1 && ctx.measureText(line + (line !== title ? '…' : '')).width > maxWidth) line = line.slice(0, -1);
      ctx.fillText(line + (line !== title ? '…' : ''), size.width / 2, half * .88);
    }
    // The photo is always drawn from the local source, never from the AI panel. Exact half, with a hard boundary.
    ctx.drawImage(source, region.x, region.y, region.width, region.height, 0, half, size.width, half);
    return { blob: await canvasBlob(canvas), ...size, createdAt: new Date().toISOString(), revision: work.revision };
  } finally { source.close(); panel?.close(); }
}
export async function photoPreview(work: MagnetWork, canvas: HTMLCanvasElement, isCurrent = () => true) {
  const source = await decode(work.sourcePhoto);
  try {
    if (!isCurrent()) return;
    const region = photoRegion(source.width, source.height, work.photoCrop);
    canvas.width = 600; canvas.height = 400;
    canvas.getContext('2d')!.drawImage(source, region.x, region.y, region.width, region.height, 0, 0, 600, 400);
  } finally { source.close(); }
}
