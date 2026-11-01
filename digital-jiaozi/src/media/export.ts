import { CARD_LAYOUT, fitImage, fitTitle, geometry } from './layout.ts';
import { canvasBlob } from './photo.ts';
import { fallbackImage, landmarkSource, loadImage } from './assets.ts';
import type { Claim, Photo } from '../domain/types.ts';
import type { JiaoziRepository } from '../storage/repository.ts';

export async function exportMemory(options: { title: string; claims: Claim[]; photos: Photo[]; repository: JiaoziRepository; assetBase: string }): Promise<{ blob: Blob; warnings: string[] }> {
  const warnings: string[] = [], width = 1200, pageHeight = 1800;
  const photoPages = Math.ceil(options.photos.length / 6), canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = pageHeight * (1 + photoPages);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f5eddd'; ctx.fillRect(0, 0, width, canvas.height);
  for (let p = 0; p <= photoPages; p++) {
    const top = p * pageHeight;
    ctx.strokeStyle = '#a48a61'; ctx.lineWidth = 3; ctx.strokeRect(30, top + 30, width - 60, pageHeight - 60);
    ctx.lineWidth = 1; ctx.strokeRect(45, top + 45, width - 90, pageHeight - 90);
    ctx.textAlign = 'center'; ctx.fillStyle = '#393b30'; ctx.font = '500 52px sans-serif';
    ctx.fillText(fitTitle(p ? options.title + ' · 照片记忆' : options.title, width * .8, t => ctx.measureText(t).width), width / 2, top + CARD_LAYOUT.titleY * pageHeight);
    ctx.font = '25px sans-serif'; ctx.fillStyle = '#756c5b'; ctx.fillText(p ? '由自己的照片制作 · 不计交子' : '每一处到访，都成为一份记忆', width / 2, top + CARD_LAYOUT.subtitleY * pageHeight);
    const entries = p === 0 ? options.claims : options.photos.slice((p - 1) * 6, p * 6);
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i], slot = geometry(width)[i]; let image: HTMLImageElement;
      let objectUrl: string | undefined;
      try {
        if ('place' in entry) image = await loadImage(landmarkSource(entry.place, options.assetBase));
        else { const blob = await options.repository.media(entry.mediaId); if (!blob) throw new Error('本地照片丢失'); objectUrl = URL.createObjectURL(blob); image = await loadImage(objectUrl); }
      } catch {
        warnings.push(('place' in entry ? entry.place.name : entry.title) + '：使用缺图提示');
        image = await loadImage(fallbackImage());
      }
      const map = 'place' in entry ? entry.place.map : { fit: 'contain' as const, position: '50% 50%' };
      const fit = fitImage(image.naturalWidth, image.naturalHeight, slot.x, top + slot.y, slot.width, slot.imageHeight, map.fit, map.position);
      ctx.save(); ctx.beginPath(); ctx.rect(slot.x, top + slot.y, slot.width, slot.imageHeight); ctx.clip();
      ctx.drawImage(image, fit.x, fit.y, fit.w, fit.h);
      ctx.restore();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      ctx.fillStyle = '#383b30'; ctx.font = '41px sans-serif';
      const name = 'place' in entry ? entry.place.name : entry.title;
      ctx.fillText(fitTitle(name, slot.width, t => ctx.measureText(t).width), slot.x + slot.width / 2, top + slot.y + slot.nameY);
      ctx.font = '31px sans-serif'; ctx.fillStyle = '#786e5d';
      const date = 'place' in entry ? entry.occurredAt : entry.createdAt;
      ctx.fillText(new Date(date).toLocaleDateString('zh-CN'), slot.x + slot.width / 2, top + slot.y + slot.dateY);
    }
    if (!entries.length) { ctx.fillStyle = '#897c63'; ctx.font = '32px sans-serif'; ctx.fillText('旅程刚刚开始，等待下一处风景', width / 2, top + pageHeight / 2); }
    ctx.font = '24px sans-serif'; ctx.fillStyle = '#786e5d'; ctx.fillText(`数字交子 · ${p + 1} / ${1 + photoPages} · 当前浏览器的旅行记忆`, width / 2, top + CARD_LAYOUT.footerY * pageHeight);
  }
  return { blob: await canvasBlob(canvas), warnings };
}
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click();
  // Keep the object alive long enough for mobile browser download dispatch.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
