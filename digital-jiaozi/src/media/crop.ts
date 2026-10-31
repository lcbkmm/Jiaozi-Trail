// Ported from the existing WeChat crop-math: x/y use full oriented dimensions,
// size uses the shorter side. Pointer movement always uses incremental anchors.
export interface CropState { width: number; height: number; viewport: number; scale: number; left: number; top: number }
export interface Crop { x: number; y: number; size: number }
export function clamp(s: CropState): CropState {
  s.left = Math.min(0, Math.max(s.viewport - s.width * s.scale, s.left));
  s.top = Math.min(0, Math.max(s.viewport - s.height * s.scale, s.top)); return s;
}
export function initial(width: number, height: number, viewport: number): CropState {
  const scale = viewport / Math.min(width, height);
  return clamp({ width, height, viewport, scale, left: (viewport - width * scale) / 2, top: (viewport - height * scale) / 2 });
}
export function normalized(s: CropState): Crop {
  return { x: Math.max(0, -s.left / (s.width * s.scale)), y: Math.max(0, -s.top / (s.height * s.scale)), size: Math.min(1, s.viewport / (Math.min(s.width, s.height) * s.scale)) };
}
export function zoom(s: CropState, multiplier: number): CropState {
  const min = s.viewport / Math.min(s.width, s.height), scale = Math.max(min, Math.min(min * 4, s.scale * multiplier)), ratio = scale / s.scale;
  return clamp({ ...s, scale, left: s.viewport / 2 - (s.viewport / 2 - s.left) * ratio, top: s.viewport / 2 - (s.viewport / 2 - s.top) * ratio });
}
