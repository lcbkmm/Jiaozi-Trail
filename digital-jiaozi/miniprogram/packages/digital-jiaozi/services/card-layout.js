const rules = require('../config/rules.json');
// All lengths derive from the same 3:2 card. Reserve name + gap BEFORE sizing art.
function geometry(width) {
  const height = width * 2 / 3, nameHeight = height * .05, gap = height * .01;
  return rules.slots.map(slot => {
    const w = slot.w * width, h = slot.h * height, size = Math.min(w, h - nameHeight - gap);
    return { x: slot.x * width, y: slot.y * height, w, h, size,
      imageLeft: (w - size) / 2, nameTop: size + gap, nameHeight, fontSize: height * .043 };
  });
}
function contain(iw, ih, x, y, w, h) {
  const scale = Math.min(w / iw, h / ih);
  return { x: x + (w - iw * scale) / 2, y: y + (h - ih * scale) / 2, w: iw * scale, h: ih * scale };
}
function title(text) { return Array.from(text).length > 7 ? Array.from(text).slice(0, 6).join('') + '…' : text; }
module.exports = { geometry, contain, title };
