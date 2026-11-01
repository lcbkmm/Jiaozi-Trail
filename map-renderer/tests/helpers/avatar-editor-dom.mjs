// Small UI harness; browser rendering/real media capture are intentionally not
// simulated. Used to verify modal lifecycle and cancellation of async work.
export class AvatarEditorTestElement extends EventTarget {
  constructor(doc, type = '') { super(); this.doc = doc; this.type = type; this.children = []; this.nodes = new Map(); this.value = ''; this.hidden = false; this.disabled = false; this.isConnected = true; this.classList = { toggle() {} }; this.textContent = ''; }
  setAttribute() {} append(child) { this.children.push(child); } remove() { this.isConnected = false; }
  set innerHTML(value) { for (const match of value.matchAll(/data-avatar="([^"]+)"/g)) this.nodes.set(match[1], new AvatarEditorTestElement(this.doc)); this.nodes.set('form', new AvatarEditorTestElement(this.doc)); }
  querySelector(value) { return value === 'form' ? this.nodes.get('form') : this.nodes.get(value.match(/data-avatar="([^"]+)"/)?.[1]); }
  getContext() { const noop = () => {}; return new Proxy({ createLinearGradient: () => ({ addColorStop() {} }), getImageData: () => ({ data: new Uint8ClampedArray(256 * 256 * 4) }) }, { get: (target, key) => target[key] || noop }); }
  toDataURL() { return 'data:image/webp;base64,AAAA'; }
  focus() { this.doc.activeElement = this; } showModal() { this.open = true; } close() { this.open = false; } click() { this.dispatchEvent(new Event('click')); }
  pause() {} play() { return Promise.resolve(); }
}
