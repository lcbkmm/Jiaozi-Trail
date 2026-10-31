const config = require('../config/card-layout.json');

function dimensions(width) {
  return { width, height: width * config.aspectRatio[1] / config.aspectRatio[0] };
}

// All six cells include their image, gap, name line and both paddings.
function geometry(width) {
  const { height } = dimensions(width), scale = width / config.cardWidthRpx;
  const nameHeight = config.nameLineHeightRpx * scale, gap = config.imageNameGapRpx * scale;
  const imageTop = config.cellPaddingTopRpx * scale, bottom = config.cellPaddingBottomRpx * scale;
  return config.rows.flatMap(y => config.columns.map(x => {
    const w = config.cellWidth * width, h = config.cellHeight * height;
    const size = Math.min(w, h - nameHeight - gap - imageTop - bottom);
    return { x: x * width, y: y * height, w, h, size, imageTop,
      imageLeft: (w - size) / 2, nameTop: imageTop + size + gap,
      nameHeight, fontSize: config.nameFontRpx * scale };
  }));
}
function contain(iw, ih, x, y, w, h) {
  const scale = Math.min(w / iw, h / ih);
  return { x: x + (w - iw * scale) / 2, y: y + (h - ih * scale) / 2, w: iw * scale, h: ih * scale };
}
// The caller supplies the renderer's actual font measurement. Never shrink text.
function fitTitle(text, maxWidth, measure) {
  const value = String(text || '');
  if (measure(value) <= maxWidth) return value;
  const chars = Array.from(value);
  while (chars.length && measure(chars.join('') + '…') > maxWidth) chars.pop();
  return chars.join('') + '…';
}

module.exports = { config, dimensions, geometry, contain, fitTitle };
