import * as T from './assets/vendor/three.module.js';

// All customization stays on this device. A photo decorates the procedural
// character's face; it does not reconstruct a person's head or body in 3D.
export const DEFAULT_AVATAR_PROFILE = Object.freeze({
  version: 1,
  name: '春熙旅人',
  skinColor: '#f2c7a5',
  hairColor: '#30252b',
  outfitColor: '#de725a',
  pantsColor: '#344a59',
  accentColor: '#ffd789',
  hairStyle: 'short',
  photoDataUrl: null,
});

const states = new WeakMap();
const colorKeys = ['skinColor', 'hairColor', 'outfitColor', 'pantsColor', 'accentColor'];

export function normalizeAvatarProfile(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  const profile = { ...DEFAULT_AVATAR_PROFILE };
  for (const key of colorKeys) if (typeof value[key] === 'string' && /^#[\da-f]{6}$/i.test(value[key])) profile[key] = value[key].toLowerCase();
  if (typeof value.name === 'string') profile.name = value.name.trim().slice(0, 24) || DEFAULT_AVATAR_PROFILE.name;
  profile.hairStyle = value.hairStyle === 'bob' ? 'bob' : 'short';
  // Restrict textures to small local raster data, with no external tracking URL,
  // SVG script, or original full-resolution photo retained in the profile.
  if (typeof value.photoDataUrl === 'string' && value.photoDataUrl.length <= 4_000_000
    && /^data:image\/(?:png|jpe?g|webp);base64,[\da-z+/=\s]+$/i.test(value.photoDataUrl)) profile.photoDataUrl = value.photoDataUrl;
  return profile;
}

/** Smooth, articulated map character. Front is +Z, feet are at Y=0. */
export function createMapAvatar(profile = {}) {
  const group = new T.Group(); group.name = 'map-avatar';
  const body = new T.Group(); body.name = 'avatar-body'; group.add(body);
  const materials = {}, geometries = new Set();
  const material = (key, color, options = {}) => materials[key] = new T.MeshStandardMaterial({ color, roughness: .72, metalness: 0, ...options });
  material('skin', DEFAULT_AVATAR_PROFILE.skinColor); material('hair', DEFAULT_AVATAR_PROFILE.hairColor, { roughness: .5 });
  material('outfit', DEFAULT_AVATAR_PROFILE.outfitColor); material('pants', DEFAULT_AVATAR_PROFILE.pantsColor);
  material('accent', DEFAULT_AVATAR_PROFILE.accentColor); material('shirt', '#faf4e7');
  material('sole', '#f7f5ee'); material('shoe', '#dadfd9'); material('ink', '#302c35', { roughness: .45 });
  material('eyeLight', '#fff8e9', { roughness: .28 }); material('blush', '#e89c93', { transparent: true, opacity: .48, depthWrite: false });
  material('bag', '#6f9596'); material('zip', '#c5c4ba', { metalness: .25, roughness: .4 });
  const sphere = new T.SphereGeometry(1, 24, 16); geometries.add(sphere);
  const geometry = geo => { geometries.add(geo); return geo; };
  function mesh(parent, name, geo, mat, position = [0, 0, 0], scale = [1, 1, 1]) {
    const object = new T.Mesh(geo, mat); object.name = name;
    object.position.set(...position); object.scale.set(...scale);
    object.castShadow = true; object.receiveShadow = true; parent.add(object); return object;
  }
  const oval = (parent, name, mat, position, scale) => mesh(parent, name, sphere, mat, position, scale);
  const capsule = (radius, length) => geometry(new T.CapsuleGeometry(radius, length, 8, 20));
  function stroke(parent, name, points, width, mat) {
    return mesh(parent, name, geometry(new T.TubeGeometry(new T.CatmullRomCurve3(points.map(p => new T.Vector3(...p))), 16, width, 8, false)), mat);
  }

  // Sneakers have a raised toe, a separate sole, heel tab, laces, and socks.
  const legs = [], arms = [];
  for (const side of [-1, 1]) {
    const leg = new T.Group(); leg.name = side < 0 ? 'left-leg' : 'right-leg'; leg.position.set(side * .225, 1.23, 0); body.add(leg); legs.push(leg);
    mesh(leg, 'trouser-leg', capsule(.175, .56), materials.pants, [0, -.39, 0], [1, 1, .95]);
    mesh(leg, 'sock', capsule(.13, .13), materials.shirt, [0, -.87, .015]);
    oval(leg, 'sneaker-sole', materials.sole, [0, -1.105, .11], [.215, .11, .36]);
    oval(leg, 'sneaker-upper', materials.shoe, [0, -1.025, .095], [.2, .145, .325]);
    oval(leg, 'sneaker-toe', materials.sole, [0, -1.035, .315], [.18, .085, .12]);
    oval(leg, 'heel-tab', materials.accent, [0, -.96, -.18], [.09, .08, .045]);
    for (let i = 0; i < 3; i++) stroke(leg, 'shoelace', [[-.085, -.904 - i * .016, .055 + i * .055], [0, -.891 - i * .016, .055 + i * .055], [.085, -.904 - i * .016, .055 + i * .055]], .013, materials.shirt);
  }
  oval(body, 'hips', materials.pants, [0, 1.21, -.005], [.405, .24, .29]);

  // A tailored jacket silhouette is spun from a smooth profile rather than
  // stacked cubes. The light inner shirt, zipper and collar remain distinct.
  const jacketProfile = [[.34, 1.13], [.43, 1.16], [.47, 1.28], [.47, 1.69], [.43, 1.96], [.34, 2.1], [.22, 2.14]];
  mesh(body, 'jacket', geometry(new T.LatheGeometry(jacketProfile.map(p => new T.Vector2(...p)), 40)), materials.outfit, [0, 0, 0], [1, 1, .72]);
  oval(body, 'inner-shirt', materials.shirt, [0, 1.73, .319], [.23, .36, .055]);
  oval(body, 'jacket-waistband', materials.outfit, [0, 1.2, .01], [.43, .1, .307]);
  mesh(body, 'neck', capsule(.145, .16), materials.skin, [0, 2.18, 0]);
  for (const side of [-1, 1]) {
    stroke(body, 'jacket-opening', [[side * .13, 2.075, .25], [side * .22, 1.83, .328], [side * .2, 1.27, .325]], .024, materials.outfit);
    const collar = oval(body, 'folded-collar', materials.shirt, [side * .145, 2.052, .25], [.10, .16, .045]); collar.rotation.z = side * .5;
    stroke(body, 'pocket-trim', [[side * .28, 1.48, .29], [side * .37, 1.55, .245]], .018, materials.accent);
    const arm = new T.Group(); arm.name = side < 0 ? 'left-arm' : 'right-arm'; arm.position.set(side * .455, 1.98, .005); arm.rotation.z = side * .15; body.add(arm); arms.push(arm);
    mesh(arm, 'jacket-sleeve', capsule(.155, .42), materials.outfit, [side * .025, -.29, 0]);
    mesh(arm, 'sleeve-cuff', capsule(.147, .045), materials.accent, [side * .025, -.56, 0]);
    oval(arm, 'hand', materials.skin, [side * .025, -.73, .015], [.135, .18, .125]);
    oval(arm, 'thumb', materials.skin, [-side * .07, -.705, .07], [.062, .095, .066]);
  }
  stroke(body, 'zipper', [[0, 1.25, .342], [0, 1.48, .355]], .012, materials.zip);
  oval(body, 'zipper-pull', materials.zip, [0, 1.49, .37], [.025, .055, .016]);

  // A small backpack makes the silhouette readable from the usual rear view.
  oval(body, 'backpack', materials.bag, [0, 1.67, -.34], [.34, .41, .20]);
  oval(body, 'backpack-pocket', materials.bag, [0, 1.51, -.49], [.26, .17, .065]);
  stroke(body, 'backpack-pocket-zip', [[-.20, 1.59, -.535], [0, 1.61, -.557], [.20, 1.59, -.535]], .014, materials.accent);
  for (const side of [-1, 1]) stroke(body, 'backpack-strap', [[side * .27, 2.04, -.25], [side * .36, 1.91, .16], [side * .34, 1.46, .24]], .047, materials.bag);

  const head = new T.Group(); head.name = 'avatar-head'; head.position.y = 2.77; body.add(head);
  mesh(head, 'head', geometry(new T.SphereGeometry(1, 40, 28)), materials.skin, [0, 0, 0], [.65, .66, .59]);
  for (const side of [-1, 1]) {
    oval(head, 'ear', materials.skin, [side * .625, -.025, 0], [.12, .18, .105]);
    oval(head, 'ear-inner', materials.blush, [side * .665, -.025, .065], [.047, .095, .025]);
  }
  const faceFeatures = new T.Group(); faceFeatures.name = 'drawn-face'; head.add(faceFeatures);
  for (const side of [-1, 1]) {
    const eye = oval(faceFeatures, 'eye', materials.ink, [side * .225, .035, .554], [.064, .098, .027]); eye.rotation.y = side * .29;
    oval(faceFeatures, 'eye-highlight', materials.eyeLight, [side * .225 - .017, .072, .577], [.021, .027, .011]);
    stroke(faceFeatures, 'eyebrow', [[side * .15, .20, .547], [side * .225, .22, .541], [side * .30, .20, .514]], .017, materials.hair);
    oval(faceFeatures, 'cheek', materials.blush, [side * .348, -.12, .484], [.095, .045, .018]);
  }
  oval(faceFeatures, 'nose', materials.skin, [0, -.085, .592], [.065, .075, .08]);
  stroke(faceFeatures, 'smile', [[-.10, -.245, .546], [0, -.275, .557], [.10, -.245, .546]], .018, materials.ink);

  const hair = new T.Group(); hair.name = 'hair'; head.add(hair);
  mesh(hair, 'hair-cap', geometry(new T.SphereGeometry(1, 40, 24, 0, Math.PI * 2, 0, Math.PI * .47)), materials.hair, [0, .005, -.018], [.686, .715, .635]);
  const shortHair = new T.Group(); shortHair.name = 'short-hair'; hair.add(shortHair);
  oval(shortHair, 'back-hair', materials.hair, [0, .17, -.40], [.61, .43, .24]);
  for (const side of [-1, 1]) oval(shortHair, 'sideburn', materials.hair, [side * .603, .12, -.04], [.085, .24, .16]);
  const bobHair = new T.Group(); bobHair.name = 'bob-hair'; hair.add(bobHair);
  oval(bobHair, 'bob-back', materials.hair, [0, -.02, -.38], [.66, .56, .27]);
  for (const side of [-1, 1]) {
    const lock = oval(bobHair, 'bob-side', materials.hair, [side * .605, -.09, -.02], [.16, .49, .24]); lock.rotation.z = -side * .09;
    const fringe = oval(hair, 'side-fringe', materials.hair, [side * .43, .37, .32], [.25, .29, .17]); fringe.rotation.z = side * .38;
  }
  const fringe = oval(hair, 'swept-fringe', materials.hair, [-.12, .405, .46], [.39, .16, .13]); fringe.rotation.z = -.20;
  const crown = oval(hair, 'crown-lock', materials.hair, [-.13, .665, -.03], [.28, .10, .21]); crown.rotation.z = -.16;

  // A curved patch follows the same head surface, so a local cartoonized photo
  // is part of the character rather than a rectangular billboard in the map.
  const photoMaterial = new T.MeshStandardMaterial({ color: '#ffffff', roughness: .84, transparent: true, alphaTest: .03 });
  materials.photo = photoMaterial;
  // Match the editor's 156:162 portrait area when viewed from the front. The
  // former short vertical arc stretched faces sideways on the 3D character.
  const photoFace = mesh(head, 'local-photo-face', geometry(new T.SphereGeometry(1, 36, 28, Math.PI * .16, Math.PI * .68, Math.PI * .145, Math.PI * .71)), photoMaterial, [0, 0, 0], [.658, .668, .598]);
  photoFace.visible = false;

  const ringMaterial = new T.MeshBasicMaterial({ color: DEFAULT_AVATAR_PROFILE.accentColor, side: T.DoubleSide, toneMapped: false }); materials.ring = ringMaterial;
  const ring = mesh(group, 'location-ring', geometry(new T.RingGeometry(.94, 1.065, 64)), ringMaterial, [0, .025, 0]);
  ring.rotation.x = -Math.PI / 2; ring.castShadow = ring.receiveShadow = false;
  const tipShape = new T.Shape(); tipShape.moveTo(-.12, 1.11); tipShape.lineTo(0, 1.36); tipShape.lineTo(.12, 1.11); tipShape.closePath();
  const tipGeometry = geometry(new T.ShapeGeometry(tipShape)); tipGeometry.rotateX(Math.PI / 2);
  const tip = mesh(group, 'heading-tip', tipGeometry, ringMaterial, [0, .03, 0]); tip.castShadow = tip.receiveShadow = false;

  states.set(group, { body, head, arms, legs, shortHair, bobHair, faceFeatures, photoFace, materials, geometries, profile: null, photoRevision: 0, photo: null, ready: Promise.resolve(false), disposed: false });
  group.userData.avatarType = 'local-procedural-character';
  applyAvatarProfile(group, profile);
  return group;
}

export function applyAvatarProfile(group, value = {}) {
  const state = states.get(group);
  if (!state || state.disposed) throw new TypeError('Use a living character created by createMapAvatar.');
  const profile = normalizeAvatarProfile({ ...state.profile, ...value });
  state.profile = profile; group.userData.avatarProfile = { ...profile };
  for (const [key, slot] of Object.entries({ skinColor: 'skin', hairColor: 'hair', outfitColor: 'outfit', pantsColor: 'pants', accentColor: 'accent' })) state.materials[slot].color.set(profile[key]);
  state.materials.ring.color.set(profile.accentColor);
  state.shortHair.visible = profile.hairStyle === 'short'; state.bobHair.visible = profile.hairStyle === 'bob';
  if (state.photoDataUrl !== profile.photoDataUrl) setPhoto(group, state, profile.photoDataUrl);
  return group;
}

function setPhoto(group, state, dataUrl) {
  const revision = ++state.photoRevision; state.photoDataUrl = dataUrl;
  state.photo?.dispose(); state.photo = null; state.materials.photo.map = null; state.materials.photo.needsUpdate = true;
  state.photoFace.visible = false; state.faceFeatures.visible = true;
  group.userData.avatarPhotoState = dataUrl ? 'loading' : 'none';
  if (!dataUrl) { state.ready = Promise.resolve(false); return; }
  state.ready = new Promise(resolve => {
    const current = () => !state.disposed && revision === state.photoRevision;
    try {
      state.photo = new T.TextureLoader().load(dataUrl, texture => {
        if (!current()) { texture.dispose(); resolve(false); return; }
        texture.colorSpace = T.SRGBColorSpace; texture.anisotropy = 4;
        state.materials.photo.map = texture; state.materials.photo.needsUpdate = true;
        state.photoFace.visible = true; state.faceFeatures.visible = false;
        group.userData.avatarPhotoState = 'ready'; resolve(true);
      }, undefined, () => {
        if (current()) { state.photo?.dispose(); state.photo = null; group.userData.avatarPhotoState = 'error'; }
        resolve(false);
      });
    } catch {
      // Missing browser image APIs or a failed local decode keep the modeled
      // face usable; uploading a photo never prevents the map from rendering.
      if (current()) group.userData.avatarPhotoState = 'error';
      resolve(false);
    }
  });
}

export function whenAvatarPhotoReady(group) {
  return states.get(group)?.ready || Promise.resolve(false);
}

/** Optional walk cycle; it never changes the map-controlled position or yaw. */
export function animateMapAvatar(group, seconds, moving = false) {
  const state = states.get(group); if (!state || state.disposed) return;
  const time = Number.isFinite(seconds) ? seconds : 0, phase = time * 8;
  state.body.position.y = moving ? Math.abs(Math.sin(phase)) * .045 : Math.sin(time * 2) * .012;
  for (let i = 0; i < 2; i++) {
    const swing = moving ? Math.sin(phase + i * Math.PI) : 0;
    state.legs[i].rotation.x = swing * .29; state.arms[i].rotation.x = moving ? -swing * .32 : 0;
  }
  state.head.rotation.z = moving ? Math.sin(phase) * .018 : Math.sin(time * 1.3) * .012;
}

export function disposeMapAvatar(group) {
  const state = states.get(group); if (!state || state.disposed) return;
  state.disposed = true; state.photoRevision++; state.photo?.dispose();
  for (const material of Object.values(state.materials)) material.dispose();
  for (const geometry of state.geometries) geometry.dispose();
}
