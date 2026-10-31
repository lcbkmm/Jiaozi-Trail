const rules=require('../config/rules.json');
const manifest=require('../config/asset-manifest.json');
const layout=require('./card-layout');
function cells(stamps,page){return layout.geometry(686).map((g,i)=>({index:i,stamp:stamps[page*6+i]||null,name:stamps[page*6+i]?layout.title(stamps[page*6+i].title):'',style:`left:${rules.slots[i].x*100}%;top:${rules.slots[i].y*100}%;width:${rules.slots[i].w*100}%;height:${rules.slots[i].h*100}%;`,imageStyle:`left:${g.imageLeft/g.w*100}%;width:${g.size/g.w*100}%;height:${g.size/g.h*100}%;`,nameStyle:`top:${g.nameTop/g.h*100}%;height:${g.nameHeight/g.h*100}%;font-size:${g.fontSize}rpx;`}));}
async function localImage(url){
  if(!/^https?:/.test(url))return url;
  return new Promise((resolve,reject)=>wx.downloadFile({url,success:r=>r.statusCode===200?resolve(r.tempFilePath):reject(new Error('图片下载失败')),fail:reject}));
}
async function drawImage(canvas,ctx,url,x,y,w,h){
  if(!url)return false;
  try{const path=await localImage(url),img=canvas.createImage();await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=path;});const box=layout.contain(img.width,img.height,x,y,w,h);ctx.drawImage(img,box.x,box.y,box.w,box.h);return true;}catch{return false;}
}
async function exportPage(page,overview,pageIndex){
  const node=await new Promise(resolve=>wx.createSelectorQuery().in(page).select('#dj-export').fields({node:true,size:true}).exec(r=>resolve(r[0]&&r[0].node)));
  if(!node)throw new Error('当前基础库不支持 Canvas 2D');node.width=1200;node.height=1000;const ctx=node.getContext('2d'),y=100,h=800,w=1200;
  ctx.fillStyle='#F8F4E9';ctx.fillRect(0,0,1200,1000);
  await drawImage(node,ctx,manifest.B01.path,0,y,w,h);
  ctx.strokeStyle=overview.stageColor;ctx.lineWidth=overview.stage==='commemorative'?7:4;ctx.strokeRect(20,y+20,w-40,h-40);
  ctx.fillStyle='#2B2926';ctx.font='38px sans-serif';ctx.textAlign='center';ctx.fillText('循交子之迹 · 留一城记忆',600,65);ctx.font='32px sans-serif';ctx.fillText(overview.title,600,y+100);
  for(let i=0;i<6;i++){
    const g=layout.geometry(w)[i],stamp=overview.stamps[pageIndex*6+i],x=g.x,top=y+g.y,cw=g.w,size=g.size,left=x+g.imageLeft;
    if(stamp){
      const url=stamp.imageUrl||(manifest[stamp.assetId]&&manifest[stamp.assetId].path),ok=await drawImage(node,ctx,url,left,top,size,size);
      if(!ok){ctx.strokeStyle='#B83A32';ctx.lineWidth=4;ctx.beginPath();ctx.arc(x+cw/2,top+size/2,size*.42,0,Math.PI*2);ctx.stroke();ctx.fillStyle='#B83A32';ctx.font='24px sans-serif';ctx.fillText('暂缺',x+cw/2,top+size/2+8);}
      ctx.fillStyle='#2B2926';ctx.font=`${g.fontSize}px sans-serif`;ctx.textBaseline='middle';ctx.fillText(layout.title(stamp.title),x+cw/2,top+g.nameTop+g.nameHeight/2,cw);ctx.textBaseline='alphabetic';
    }else{ctx.strokeStyle='#d4cbbb';ctx.lineWidth=2;ctx.beginPath();ctx.arc(x+cw/2,top+size/2,size*.4,0,Math.PI*2);ctx.stroke();}
  }
  ctx.font='24px sans-serif';ctx.fillStyle=overview.stageColor;ctx.fillText(`${overview.stageName} · ${overview.serial} · 第 ${pageIndex+1} 页`,600,y+h*.94);
  ctx.font='22px sans-serif';ctx.fillStyle='#70685d';ctx.fillText(overview.demo?'演示活动 · 地点素材为示意 · 照片章不代表到店认证':'个人旅行记忆 · 自制章不代表到店认证',600,960);
  return new Promise((resolve,reject)=>wx.canvasToTempFilePath({canvas:node,fileType:'png',success:r=>resolve(r.tempFilePath),fail:reject},page));
}
module.exports={cells,exportPage};
