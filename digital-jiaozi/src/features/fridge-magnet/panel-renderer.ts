import type { PanelCrop } from './types.ts';
import { panelRegion } from './geometry.ts';
// Deliberately use an explicit crop. Background detection cannot reliably distinguish shadows or subject details.
export function renderPanel(ctx: CanvasRenderingContext2D, image: ImageBitmap, crop: PanelCrop, box: { x: number; y: number; width: number; height: number }) {
  const region = panelRegion(image.width, image.height, crop);
  const scale = Math.min(box.width / region.width, box.height / region.height);
  const w = region.width * scale, h = region.height * scale;
  ctx.drawImage(image, region.x, region.y, region.width, region.height, box.x + (box.width - w) / 2, box.y + (box.height - h) / 2, w, h);
}
