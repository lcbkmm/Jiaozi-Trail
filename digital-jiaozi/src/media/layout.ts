export const CARD_LAYOUT = {
  version: 'web-portrait-v2', aspectRatio: [2, 3], columns: [.075, .535], rows: [.16, .405, .65],
  cellWidth: .39, cellHeight: .215, imageHeight: .16,
  titleY: .075, subtitleY: .109, footerY: .936, nameOffset: .18, dateOffset: .202
} as const;
export function geometry(width: number) {
  const height = width * 1.5;
  return CARD_LAYOUT.rows.flatMap(y => CARD_LAYOUT.columns.map(x => ({
    x: x * width, y: y * height, width: CARD_LAYOUT.cellWidth * width,
    height: CARD_LAYOUT.cellHeight * height, imageHeight: CARD_LAYOUT.imageHeight * height,
    nameY: CARD_LAYOUT.nameOffset * height, dateY: CARD_LAYOUT.dateOffset * height
  })));
}
export function fitTitle(text: string, width: number, measure: (value: string) => number) {
  if (measure(text) <= width) return text;
  const chars = Array.from(text); while (chars.length && measure(chars.join('') + '…') > width) chars.pop(); return chars.join('') + '…';
}
export function contain(iw: number, ih: number, x: number, y: number, w: number, h: number) {
  const scale = Math.min(w / iw, h / ih); return { x: x + (w - iw * scale) / 2, y: y + (h - ih * scale) / 2, w: iw * scale, h: ih * scale };
}
export function imagePosition(position = '50% 50%'): [number, number] {
  if (!/^\d{1,3}% \d{1,3}%$/.test(position)) return [.5, .5];
  return position.split(' ').map(p => Math.min(100, Number.parseInt(p)) / 100) as [number, number];
}
export function fitImage(iw: number, ih: number, x: number, y: number, w: number, h: number, fit: 'contain' | 'cover', position = '50% 50%') {
  const scale = (fit === 'cover' ? Math.max : Math.min)(w / iw, h / ih);
  const [px, py] = imagePosition(position);
  return { x: x + (w - iw * scale) * px, y: y + (h - ih * scale) * py, w: iw * scale, h: ih * scale };
}
