import { DEFAULT_AVATAR_PROFILE, normalizeAvatarProfile } from './game-map-avatar.mjs';

export const AVATAR_STORAGE_KEY = 'jiaozi-map-avatar-v1';
export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;

export function validateAvatarPhoto(file) {
  if (!file || !Number.isFinite(file.size) || file.size <= 0) throw new Error('请选择一张有效照片。');
  if (file.size > MAX_PHOTO_BYTES) throw new Error('照片不能超过 12 MB，请选择较小的照片。');
  const type = String(file.type || '').toLowerCase();
  if (type ? !['image/jpeg', 'image/png', 'image/webp'].includes(type) : !/\.(?:jpe?g|png|webp)$/i.test(file.name || '')) {
    throw new Error('目前支持 JPG、PNG 和 WebP 照片，请先转换照片格式。');
  }
  return file;
}

// The crop never samples outside the source, including very wide/tall photos.
export function avatarCropRect(width, height, { zoom = 1, x = 0, y = 0 } = {}) {
  if (!(width > 0 && height > 0) || !Number.isFinite(width + height)) throw new Error('照片尺寸无效。');
  const clamp = (n, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(n)) ? Number(n) : 0));
  const side = Math.min(width, height) / clamp(zoom, 1, 3);
  return { x: (width - side) * (clamp(x, -1, 1) + 1) / 2, y: (height - side) * (clamp(y, -1, 1) + 1) / 2, width: side, height: side };
}

// A small edge-preserving blur plus soft colour steps; output retains individual
// pixels and smooth contours, rather than enlarging blocks of a low-res image.
export function cartoonizeAvatarPixels(source, width, height) {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0) || source?.length !== width * height * 4) throw new Error('头像图像数据无效。');
  const output = new Uint8ClampedArray(source.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4, sums = [0, 0, 0]; let weight = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = Math.min(width - 1, Math.max(0, x + dx)), ny = Math.min(height - 1, Math.max(0, y + dy)), i = (ny * width + nx) * 4;
      const difference = Math.abs(source[at] - source[i]) + Math.abs(source[at + 1] - source[i + 1]) + Math.abs(source[at + 2] - source[i + 2]);
      const w = (dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1) * Math.exp(-difference / 65);
      for (let c = 0; c < 3; c++) sums[c] += source[i + c] * w;
      weight += w;
    }
    const average = sums.map(v => v / weight), luma = average[0] * .299 + average[1] * .587 + average[2] * .114;
    for (let c = 0; c < 3; c++) {
      const saturated = luma + (average[c] - luma) * 1.08;
      const stepped = Math.round(saturated / 18) * 18;
      output[at + c] = saturated * .58 + stepped * .42 + 3;
    }
    output[at + 3] = source[at + 3];
  }
  return output;
}

export function readAvatarProfile(storage) {
  try { return normalizeAvatarProfile(JSON.parse(storage?.getItem(AVATAR_STORAGE_KEY) || 'null')); }
  catch { return normalizeAvatarProfile(DEFAULT_AVATAR_PROFILE); }
}
export function saveAvatarProfile(storage, profile) {
  try { if (!storage) return false; storage.setItem(AVATAR_STORAGE_KEY, JSON.stringify(normalizeAvatarProfile(profile))); return true; }
  catch { return false; }
}

// Stop both active streams and any permission request that resolves after close.
export function createAvatarCameraSession(mediaDevices) {
  let sequence = 0, stream;
  const stopStream = value => value?.getTracks?.().forEach(track => track.stop());
  function stop() { sequence++; stopStream(stream); stream = undefined; }
  return {
    async start() {
      stop(); const request = sequence;
      if (!mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持直接拍照，请使用上传照片。');
      const acquired = await mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
      if (request !== sequence) { stopStream(acquired); return null; }
      stream = acquired; return stream;
    }, stop,
  };
}

export function createAvatarEditor({ host = window, profile, onApply, onOpenChange } = {}) {
  const doc = host.document;
  let storage;
  try { storage = host.localStorage; } catch { /* Session-only editing remains available. */ }
  let current = profile ? normalizeAvatarProfile(profile) : readAvatarProfile(storage), draft = { ...current };
  let opened = false, destroyed = false, previousFocus, sourceImage, portraitImage, photoSequence = 0, cameraSequence = 0, working = false;
  const camera = createAvatarCameraSession(host.navigator?.mediaDevices);
  const dialog = doc.createElement('dialog'); dialog.id = 'map-avatar-editor'; dialog.className = 'avatar-editor';
  dialog.setAttribute('aria-labelledby', 'avatar-editor-title');
  dialog.innerHTML = `
    <form method="dialog" class="avatar-editor-form">
      <header class="avatar-editor-heading"><div><span class="avatar-editor-eyebrow">春熙路 · 我的探索角色</span><h2 id="avatar-editor-title">捏一个像你的旅行伙伴</h2></div><button type="button" data-avatar="close" class="avatar-close" aria-label="关闭角色定制">×</button></header>
      <div class="avatar-editor-layout">
        <section class="avatar-preview-side"><canvas data-avatar="preview" width="512" height="600" role="img" aria-label="卡通头像与角色配色预览"></canvas><p class="avatar-preview-caption">头像与配色预览 · 应用后查看地图中的立体角色</p><span class="avatar-local-badge">照片仅在本机处理</span></section>
        <div class="avatar-controls-side">
          <label class="avatar-name-label">角色昵称<input data-avatar="name" maxlength="20" placeholder="我的春熙路伙伴" autocomplete="off"></label>
          <section class="avatar-photo-section"><h3>用照片定制头像</h3><p>选择清晰的正面照片，将脸部放入圆框。本地柔化与色阶处理会保留照片特征，应用到卡通角色的脸部。</p>
            <div class="avatar-photo-actions"><button type="button" data-avatar="upload">上传照片</button><button type="button" data-avatar="camera">拍一张</button><button type="button" data-avatar="remove-photo" class="avatar-text-button">移除照片</button></div>
            <input type="file" data-avatar="file" accept="image/jpeg,image/png,image/webp" hidden><input type="file" data-avatar="capture-file" accept="image/jpeg,image/png,image/webp" capture="user" hidden>
            <div data-avatar="camera-panel" class="avatar-camera-panel" hidden><video data-avatar="video" autoplay muted playsinline></video><div><button type="button" data-avatar="shutter">拍摄这张</button><button type="button" data-avatar="cancel-camera">取消拍摄</button></div></div>
            <div data-avatar="crop-panel" class="avatar-crop-panel" hidden><canvas data-avatar="crop" width="256" height="256" role="img" aria-label="照片裁切预览，调整滑块使脸部位于圆框内"></canvas><div class="avatar-crop-sliders"><label>放大<input data-avatar="zoom" type="range" min="1" max="3" step="0.02" value="1"></label><label>左右<input data-avatar="crop-x" type="range" min="-1" max="1" step="0.02" value="0"></label><label>上下<input data-avatar="crop-y" type="range" min="-1" max="1" step="0.02" value="0"></label></div></div>
          </section>
          <section class="avatar-customize-section"><h3>角色造型</h3><label class="avatar-hair-label">发型<select data-avatar="hairStyle"><option value="short">轻盈短发</option><option value="bob">柔顺短波波</option></select></label><div class="avatar-colors">
          <label>肤色<input type="color" data-avatar="skinColor"></label><label>发色<input type="color" data-avatar="hairColor"></label><label>外套<input type="color" data-avatar="outfitColor"></label><label>长裤<input type="color" data-avatar="pantsColor"></label><label>配饰<input type="color" data-avatar="accentColor"></label></div></section>
        </div>
      </div>
      <p data-avatar="status" class="avatar-editor-status" role="status" aria-live="polite"></p>
      <footer class="avatar-editor-footer"><button type="button" data-avatar="reset" class="avatar-text-button">恢复默认角色</button><div><button type="button" data-avatar="cancel">取消</button><button type="submit" data-avatar="apply" class="avatar-primary">应用到地图</button></div></footer>
    </form>`;
  doc.body.append(dialog);
  const el = key => dialog.querySelector(`[data-avatar="${key}"]`), form = dialog.querySelector('form');
  const fields = ['name', 'hairStyle', 'skinColor', 'hairColor', 'outfitColor', 'pantsColor', 'accentColor'];
  const preview = el('preview'), previewContext = preview.getContext('2d');
  const cropCanvas = el('crop'), cropContext = cropCanvas.getContext('2d', { willReadFrequently: true });
  const workCanvas = doc.createElement('canvas'); workCanvas.width = workCanvas.height = 256;
  const workContext = workCanvas.getContext('2d', { willReadFrequently: true });
  const video = el('video');
  function status(message, error = false) { el('status').textContent = message; el('status').classList.toggle('is-error', error); }
  function busy(value) { working = value; el('apply').disabled = value; el('upload').disabled = value; el('camera').disabled = value; }
  function stopCamera() { ++cameraSequence; camera.stop(); video.pause?.(); video.srcObject = null; el('camera-panel').hidden = true; }
  function setFields() { fields.forEach(key => { el(key).value = draft[key]; }); el('remove-photo').disabled = !draft.photoDataUrl; }

  function drawPreview() {
    const ctx = previewContext; if (!ctx) return;
    ctx.clearRect(0, 0, 512, 600);
    const background = ctx.createLinearGradient(0, 0, 0, 600); background.addColorStop(0, '#fbf1dd'); background.addColorStop(1, '#e4eadf'); ctx.fillStyle = background; ctx.fillRect(0, 0, 512, 600);
    const oval = (x, y, rx, ry, color) => { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); };
    const rounded = (x, y, w, h, r, color) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fillStyle = color; ctx.fill(); };
    oval(256, 533, 132, 17, '#6e796723');
    rounded(198, 387, 48, 117, 22, draft.pantsColor); rounded(267, 387, 48, 117, 22, draft.pantsColor);
    rounded(186, 482, 64, 37, 17, '#fffcf3'); rounded(265, 482, 64, 37, 17, '#fffcf3');
    rounded(189, 498, 58, 11, 5, draft.accentColor); rounded(268, 498, 58, 11, 5, draft.accentColor);
    rounded(154, 280, 48, 125, 23, draft.outfitColor); rounded(312, 280, 48, 125, 23, draft.outfitColor);
    oval(177, 399, 20, 24, draft.skinColor); oval(337, 399, 20, 24, draft.skinColor);
    rounded(186, 263, 140, 148, 40, draft.outfitColor); rounded(238, 272, 37, 127, 13, '#fff8e9');
    rounded(252, 280, 7, 114, 3, '#ffffffc0'); rounded(280, 327, 29, 24, 6, draft.accentColor);
    rounded(235, 236, 43, 47, 15, draft.skinColor);
    if (draft.hairStyle === 'bob') rounded(157, 107, 201, 159, 65, draft.hairColor);
    oval(256, 162, 103, 95, draft.hairColor); oval(164, 188, 14, 22, draft.skinColor); oval(348, 188, 14, 22, draft.skinColor);
    oval(256, 183, 88, 90, draft.skinColor);
    if (portraitImage && draft.photoDataUrl) {
      ctx.save(); ctx.beginPath(); ctx.ellipse(256, 186, 78, 81, 0, 0, Math.PI * 2); ctx.clip(); ctx.drawImage(portraitImage, 178, 105, 156, 162); ctx.restore();
    } else {
      oval(222, 184, 9, 13, '#3a363a'); oval(290, 184, 9, 13, '#3a363a'); oval(219, 179, 3, 4, '#fff'); oval(287, 179, 3, 4, '#fff');
      oval(207, 209, 17, 8, '#e4918588'); oval(305, 209, 17, 8, '#e4918588');
      ctx.beginPath(); ctx.arc(256, 211, 22, .2, Math.PI - .2); ctx.strokeStyle = '#9f655f'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.stroke();
    }
    oval(215, 114, 58, 28, draft.hairColor); oval(285, 103, 54, 27, draft.hairColor);
    ctx.fillStyle = '#46584e'; ctx.font = '500 21px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(draft.name || '我的春熙路伙伴', 256, 574, 440);
  }

  function refreshPortrait() {
    portraitImage = undefined; drawPreview();
    if (!draft.photoDataUrl) return;
    const data = draft.photoDataUrl, picture = new host.Image();
    picture.onload = () => { if (!destroyed && draft.photoDataUrl === data) { portraitImage = picture; drawPreview(); } };
    picture.onerror = () => { if (draft.photoDataUrl === data) status('头像预览暂时无法读取，可以移除照片后重新选择。', true); };
    picture.src = data;
  }

  function renderCrop() {
    if (!sourceImage || !cropContext || !workContext) return;
    const rect = avatarCropRect(sourceImage.naturalWidth || sourceImage.width, sourceImage.naturalHeight || sourceImage.height, { zoom: Number(el('zoom').value), x: Number(el('crop-x').value), y: Number(el('crop-y').value) });
    workContext.clearRect(0, 0, 256, 256); workContext.imageSmoothingEnabled = true; workContext.imageSmoothingQuality = 'high';
    workContext.drawImage(sourceImage, rect.x, rect.y, rect.width, rect.height, 0, 0, 256, 256);
    const image = workContext.getImageData(0, 0, 256, 256); image.data.set(cartoonizeAvatarPixels(image.data, 256, 256)); workContext.putImageData(image, 0, 0);
    const encoded = workCanvas.toDataURL('image/webp', .9);
    if (encoded.length > 450_000) throw new Error('头像内容过大，请尝试其他照片。');
    draft.photoDataUrl = encoded; cropContext.clearRect(0, 0, 256, 256); cropContext.drawImage(workCanvas, 0, 0);
    cropContext.fillStyle = '#263d374d'; cropContext.beginPath(); cropContext.rect(0, 0, 256, 256); cropContext.arc(128, 128, 113, 0, Math.PI * 2, true); cropContext.fill('evenodd');
    cropContext.beginPath(); cropContext.arc(128, 128, 113, 0, Math.PI * 2); cropContext.strokeStyle = '#fff'; cropContext.lineWidth = 2; cropContext.stroke();
    el('remove-photo').disabled = false; refreshPortrait();
  }
  function setPhotoSource(image) {
    const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
    if (!(width > 0 && height > 0) || width * height > MAX_IMAGE_PIXELS) throw new Error('照片尺寸过大或无法读取，请选择 4000 万像素以内的照片。');
    sourceImage = image; el('zoom').value = '1'; el('crop-x').value = el('crop-y').value = '0'; el('crop-panel').hidden = false; renderCrop();
  }
  async function useFile(file) {
    if (!file || destroyed || !opened) return;
    const sequence = ++photoSequence; busy(true); stopCamera();
    let url;
    try {
      validateAvatarPhoto(file); status('正在本机处理照片…'); url = host.URL.createObjectURL(file);
      const image = await new Promise((resolve, reject) => { const img = new host.Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('照片解码失败，请尝试其他 JPG、PNG 或 WebP 照片。')); img.src = url; });
      if (sequence !== photoSequence || !opened || destroyed) return;
      setPhotoSource(image); status('已生成本地卡通头像。请调整滑块，使脸部位于圆框中央。');
    } catch (error) { if (sequence === photoSequence && opened) status(error.message || '照片处理失败，请更换照片。', true); }
    finally { if (url) host.URL.revokeObjectURL(url); if (sequence === photoSequence) busy(false); }
  }
  async function openCamera() {
    if (host.matchMedia?.('(pointer: coarse)').matches || !host.navigator?.mediaDevices?.getUserMedia) { el('capture-file').click(); return; }
    const sequence = ++cameraSequence;
    el('camera-panel').hidden = false; el('shutter').disabled = true;
    status('请允许浏览器使用相机，也可以取消后上传照片。');
    try {
      const stream = await camera.start();
      if (!stream || !opened || destroyed || sequence !== cameraSequence) return;
      video.srcObject = stream; el('camera-panel').hidden = false;
      await video.play();
      if (opened && sequence === cameraSequence) { el('shutter').disabled = false; status('将脸部放在取景画面中央，然后拍摄。'); }
    } catch (error) {
      if (sequence !== cameraSequence) return;
      stopCamera();
      if (opened) status(error?.name === 'NotAllowedError' ? '未获得相机权限。你仍可以使用“上传照片”。' : '无法开启相机。请确认相机可用，或使用“上传照片”。', true);
    }
  }
  function shutter() {
    if (!video.videoWidth || !video.videoHeight) { status('相机画面尚未准备好，请稍候。', true); return; }
    try {
      const capture = doc.createElement('canvas');
      const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
      capture.width = Math.round(video.videoWidth * scale); capture.height = Math.round(video.videoHeight * scale);
      capture.getContext('2d').drawImage(video, 0, 0, capture.width, capture.height); stopCamera(); setPhotoSource(capture);
      status('已拍摄并生成本地卡通头像，可以继续调整裁切。');
    } catch { stopCamera(); status('拍摄失败，请尝试上传照片。', true); }
  }
  function removePhoto() { ++photoSequence; busy(false); stopCamera(); sourceImage = portraitImage = undefined; draft.photoDataUrl = null; el('crop-panel').hidden = true; el('remove-photo').disabled = true; drawPreview(); status('已恢复手绘卡通脸部。'); }
  function open() {
    if (destroyed || opened) return;
    previousFocus = doc.activeElement; draft = { ...current }; sourceImage = undefined; el('crop-panel').hidden = true;
    setFields(); refreshPortrait(); status('照片仅保存在当前浏览器，不会发送到外部服务。');
    dialog.showModal(); opened = true; onOpenChange?.(true); el('close').focus();
  }
  function close() {
    if (!opened) return;
    opened = false; ++photoSequence; busy(false); stopCamera(); sourceImage = undefined;
    dialog.close(); onOpenChange?.(false); if (previousFocus?.isConnected) previousFocus.focus();
  }
  function submit(event) {
    event.preventDefault(); if (working) return;
    try {
      const next = normalizeAvatarProfile(draft);
      let previousStored, canRollback = false;
      try { if (storage) { previousStored = storage.getItem(AVATAR_STORAGE_KEY); canRollback = true; } } catch { /* Keep this application in memory only. */ }
      const persisted = canRollback && saveAvatarProfile(storage, next);
      try { onApply?.({ ...next }, { persisted }); }
      catch (error) {
        // A failed renderer callback must not silently replace the saved outfit.
        if (persisted) try { previousStored == null ? storage.removeItem(AVATAR_STORAGE_KEY) : storage.setItem(AVATAR_STORAGE_KEY, previousStored); } catch { /* Surface the original application failure. */ }
        throw error;
      }
      current = next; close();
    } catch (error) { status(error?.message || '应用角色失败，请重试。', true); }
  }
  function onCancel(event) { event.preventDefault(); close(); }
  function onClick(event) {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
  }
  const bindings = [];
  function bind(target, name, listener) { target.addEventListener(name, listener); bindings.push(() => target.removeEventListener(name, listener)); }
  bind(form, 'submit', submit); bind(dialog, 'cancel', onCancel); bind(dialog, 'click', onClick);
  // Prevent map navigation shortcuts even when listeners are attached to window.
  bind(dialog, 'keydown', event => { event.stopPropagation(); });
  bind(el('close'), 'click', close); bind(el('cancel'), 'click', close);
  bind(el('upload'), 'click', () => el('file').click()); bind(el('camera'), 'click', openCamera);
  for (const key of ['file', 'capture-file']) bind(el(key), 'change', () => { const file = el(key).files?.[0]; el(key).value = ''; void useFile(file); });
  bind(el('cancel-camera'), 'click', () => { stopCamera(); status('已关闭相机。'); }); bind(el('shutter'), 'click', shutter);
  bind(el('remove-photo'), 'click', removePhoto);
  bind(el('reset'), 'click', () => { stopCamera(); removePhoto(); draft = normalizeAvatarProfile(DEFAULT_AVATAR_PROFILE); setFields(); refreshPortrait(); status('已恢复默认预览，点击“应用到地图”后生效。'); });
  fields.forEach(key => bind(el(key), 'input', () => { draft[key] = el(key).value; drawPreview(); }));
  for (const key of ['zoom', 'crop-x', 'crop-y']) bind(el(key), 'input', () => { try { renderCrop(); } catch (error) { status(error.message || '裁切失败，请重选照片。', true); } });
  return { open, close, isOpen: () => opened, currentProfile: () => ({ ...current }),
    destroy() { if (destroyed) return; close(); destroyed = true; ++photoSequence; stopCamera(); bindings.forEach(remove => remove()); dialog.remove(); }
  };
}
