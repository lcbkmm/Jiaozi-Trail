// x/y: fractions of oriented full width/height; size: fraction of the shorter side.
function clamp(state){state.left=Math.min(0,Math.max(state.viewport-state.width*state.scale,state.left));state.top=Math.min(0,Math.max(state.viewport-state.height*state.scale,state.top));return state;}
function initial(width,height,viewport,crop){
  const min=Math.min(width,height),scale=viewport/(min*(crop?crop.size:1));
  return clamp({width,height,viewport,scale,left:crop?-crop.x*width*scale:(viewport-width*scale)/2,top:crop?-crop.y*height*scale:(viewport-height*scale)/2});
}
function normalized(s){return{x:Math.max(0,-s.left/(s.width*s.scale)),y:Math.max(0,-s.top/(s.height*s.scale)),size:Math.min(1,s.viewport/(Math.min(s.width,s.height)*s.scale))};}
function zoom(s,multiplier){const scale=Math.max(s.viewport/Math.min(s.width,s.height),Math.min(s.viewport/Math.min(s.width,s.height)*4,s.scale*multiplier)),ratio=scale/s.scale;return clamp({...s,scale,left:s.viewport/2-(s.viewport/2-s.left)*ratio,top:s.viewport/2-(s.viewport/2-s.top)*ratio});}
module.exports={initial,clamp,normalized,zoom};
