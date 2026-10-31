import sharp from 'sharp';
import * as fontkit from 'fontkit';
import path from 'node:path';
import { root, rules } from '../config.js';
import { insist, DomainError } from '../domain/errors.js';
let font;
const getFont=()=>font||(font=fontkit.openSync(path.join(root,'server/fonts/NotoSansCJKsc-Regular.otf')));
const labels={building:'建筑',food:'美食',person:'人物',other:'记忆'};
// Convert bundled font glyphs to SVG paths; no system font dependency or SVG text injection.
export function textPaths(text,cx,baseline,maxWidth,size) {
  const f=getFont(),run=f.layout(text),units=run.positions.reduce((n,p)=>n+p.xAdvance,0),scale=Math.min(size/f.unitsPerEm,maxWidth/Math.max(1,units));
  let x=cx-units*scale/2;
  return run.glyphs.map((g,i)=>{
    const p=run.positions[i],result=`<path d="${g.path.toSVG()}" transform="translate(${x+p.xOffset*scale} ${baseline-p.yOffset*scale}) scale(${scale} ${-scale})"/>`;
    x+=p.xAdvance*scale;return result;
  }).join('');
}
export class PhotoRenderer {
  async normalize(bytes) {
    insist(bytes.length<=rules.maxUploadBytes,'UPLOAD_TOO_LARGE','照片不能超过 10 MB',413);
    try {
      const image=sharp(bytes,{limitInputPixels:rules.maxImagePixels,failOn:'warning'}),meta=await image.metadata();
      insist(['jpeg','png','webp'].includes(meta.format)&&(!meta.pages||meta.pages===1),'IMAGE_FORMAT','只支持单张 JPEG、PNG、WebP');
      insist(meta.width*meta.height<=rules.maxImagePixels,'IMAGE_PIXELS','照片不能超过 2400 万像素');
      const buffer=await image.rotate().png().toBuffer(),oriented=await sharp(buffer).metadata();
      return {bytes:buffer,width:oriented.width,height:oriented.height};
    } catch(error) { if(error instanceof DomainError)throw error;throw new DomainError('IMAGE_DECODE','图片无法解码、过大或已损坏'); }
  }
  async rotate(bytes) { return sharp(bytes).rotate(90).png().toBuffer(); }
  async render(bytes,draft) {
    const m=await sharp(bytes).metadata(),c=draft.crop,side=Math.round(Math.min(m.width,m.height)*c.size),left=Math.round(m.width*c.x),top=Math.round(m.height*c.y);
    insist(side>=8&&left>=0&&top>=0&&left+side<=m.width&&top+side<=m.height,'CROP_INVALID','裁剪框须位于照片内，且边长至少 8 像素');
    const s=rules.photoSize,inner=352;
    const {data,info}=await sharp(bytes).extract({left,top,width:side,height:side}).flatten({background:'#FFFFFF'}).resize(inner,inner).greyscale().raw().toBuffer({resolveWithObject:true});
    const out=Buffer.alloc(inner*inner*4),threshold=draft.threshold,polarity=draft.polarity==='light';
    for(let y=0;y<inner;y++) for(let x=0;x<inner;x++) {
      const i=y*inner+x,g=data[i*info.channels];let intensity;
      if(draft.mode==='outline') {
        const a=data[(y*inner+Math.max(0,x-1))*info.channels],b=data[(y*inner+Math.min(inner-1,x+1))*info.channels],
          c=data[(Math.max(0,y-1)*inner+x)*info.channels],d=data[(Math.min(inner-1,y+1)*inner+x)*info.channels];
        intensity=Math.hypot(a-b,c-d)*1.8;intensity=Math.max(0,Math.min(1,(intensity-(255-threshold)*0.45)/22));
      } else { const value=polarity?255-g:g;intensity=Math.max(0,Math.min(1,(threshold-value)/20+0.5)); }
      // Circular vignette removes square crop corners, preserving continuous antialiasing.
      const mask=Math.max(0,Math.min(1,(174-Math.hypot(x-175.5,y-175.5))/2));
      out[i*4]=184;out[i*4+1]=58;out[i*4+2]=50;out[i*4+3]=Math.round(intensity*mask*255);
    }
    if(draft.mode==='outline') {
      const original=Buffer.from(out);
      for(let y=2;y<inner-2;y++)for(let x=2;x<inner-2;x++) {
        let alpha=0;for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)alpha=Math.max(alpha,original[((y+dy)*inner+x+dx)*4+3]);
        out[(y*inner+x)*4+3]=alpha;
      }
    }
    const pattern=await sharp(out,{raw:{width:inner,height:inner,channels:4}}).png().toBuffer();
    const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 512 512"><g fill="none" stroke="#B83A32"><circle cx="256" cy="256" r="236" stroke-width="7"/><circle cx="256" cy="256" r="223" stroke-width="2"/></g><g fill="#B83A32">${textPaths(draft.title,256,430,320,31)}${textPaths(labels[draft.category]+' · 自制',256,464,180,18)}</g></svg>`);
    const composed=await sharp({create:{width:s,height:s,channels:4,background:'#00000000'}}).composite([{input:pattern,left:80,top:46},{input:svg}]).raw().toBuffer();
    // Preserve antialiased alpha while removing premultiplication rounding from low-alpha RGB.
    for(let i=0;i<composed.length;i+=4){composed[i]=184;composed[i+1]=58;composed[i+2]=50;}
    return sharp(composed,{raw:{width:s,height:s,channels:4}}).png().toBuffer();
  }
}
