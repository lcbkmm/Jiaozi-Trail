const manifest = require('../config/asset-manifest.json');
const layout = require('./card-layout');

function cells(stamps, page) {
  const { width, height } = layout.dimensions(layout.config.cardWidthRpx);
  return layout.geometry(width).map((g, i) => ({
    index: i, stamp: stamps[page * 6 + i] || null,
    name: stamps[page * 6 + i] ? stamps[page * 6 + i].title : '',
    style: `left:${g.x / width * 100}%;top:${g.y / height * 100}%;width:${g.w / width * 100}%;height:${g.h / height * 100}%;`,
    imageStyle: `left:${g.imageLeft / g.w * 100}%;top:${g.imageTop / g.h * 100}%;width:${g.size / g.w * 100}%;height:${g.size / g.h * 100}%;`,
    nameStyle: `top:${g.nameTop / g.h * 100}%;height:${g.nameHeight / g.h * 100}%;line-height:${g.nameHeight}rpx;font-size:${g.fontSize}rpx;`
  }));
}

function imageUrl(stamp) {
  return stamp && (stamp.imageUrl || (manifest[stamp.assetId] && manifest[stamp.assetId].path)) || '';
}

async function localImage(url) {
  if (!/^https?:/.test(url)) return url;
  return new Promise((resolve, reject) => wx.downloadFile({ url,
    success: r => r.statusCode === 200 ? resolve(r.tempFilePath) : reject(new Error('图片下载失败')), fail: reject }));
}

async function drawImage(canvas, ctx, url, x, y, w, h) {
  if (!url) return false;
  try {
    const path = await localImage(url), img = canvas.createImage();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = path; });
    const box = layout.contain(img.width, img.height, x, y, w, h);
    ctx.drawImage(img, box.x, box.y, box.w, box.h);
    return true;
  } catch { return false; }
}

async function exportPage(page, overview, pageIndex) {
  const node = await new Promise(resolve => wx.createSelectorQuery().in(page).select('#dj-export')
    .fields({ node: true, size: true }).exec(r => resolve(r[0] && r[0].node)));
  if (!node) throw new Error('当前基础库不支持 Canvas 2D');
  const { width: w, height: h } = layout.dimensions(1200);
  node.width = w; node.height = h;
  const ctx = node.getContext('2d');
  ctx.fillStyle = '#F8F4E9'; ctx.fillRect(0, 0, w, h);
  await drawImage(node, ctx, manifest.B01.path, 0, 0, w, h);
  ctx.strokeStyle = overview.stageColor; ctx.lineWidth = overview.stage === 'commemorative' ? 7 : 4;
  ctx.strokeRect(w * .02, h * .02, w * .96, h * .96);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const text = (value, y, size, maxWidth = w * .8) => {
    ctx.font = `${size}px sans-serif`;
    ctx.fillText(layout.fitTitle(value, maxWidth, s => ctx.measureText(s).width), w / 2, h * y);
  };
  ctx.fillStyle = '#2B2926'; text('循交子之迹 · 留一城记忆', .052, 36); text(overview.title, .094, 52);
  const boxes = layout.geometry(w);
  for (let i = 0; i < boxes.length; i++) {
    const g = boxes[i], stamp = overview.stamps[pageIndex * 6 + i];
    const x = g.x + g.imageLeft, top = g.y + g.imageTop;
    if (stamp) {
      const ok = await drawImage(node, ctx, imageUrl(stamp), x, top, g.size, g.size);
      if (!ok) {
        ctx.strokeStyle = '#B83A32'; ctx.lineWidth = 4; ctx.beginPath();
        ctx.arc(x + g.size / 2, top + g.size / 2, g.size * .42, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#B83A32'; ctx.font = '24px sans-serif';
        ctx.fillText('暂缺', x + g.size / 2, top + g.size / 2);
      }
      ctx.fillStyle = '#2B2926'; ctx.font = `${g.fontSize}px sans-serif`;
      ctx.fillText(layout.fitTitle(stamp.title, g.w, s => ctx.measureText(s).width), g.x + g.w / 2, g.y + g.nameTop + g.nameHeight / 2);
    } else {
      ctx.strokeStyle = '#d4cbbb'; ctx.lineWidth = 2; ctx.beginPath();
      ctx.arc(x + g.size / 2, top + g.size / 2, g.size * .4, 0, Math.PI * 2); ctx.stroke();
    }
  }
  ctx.fillStyle = overview.stageColor;
  text(`${overview.stageName} · ${overview.serial}`, .91, 34);
  text(`第 ${pageIndex + 1} 页`, .937, 32);
  ctx.fillStyle = '#70685d'; text(overview.demo ? '演示活动 · 照片章不代表到店认证' : '个人旅行记忆 · 自制章不代表到店认证', .96, 28);
  return new Promise((resolve, reject) => wx.canvasToTempFilePath({ canvas: node, fileType: 'png',
    success: r => resolve(r.tempFilePath), fail: reject }, page));
}

module.exports = { cells, imageUrl, exportPage };
