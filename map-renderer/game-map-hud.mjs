const STORAGE_KEY = 'jiaozi-map-hud-v1';
const GROUPS = [
  { key: 'tools', dock: 'map-tool-dock', toggle: 'toggle-map-tools', content: 'map-tool-actions', label: '探索工具' },
  { key: 'categories', dock: 'map-category-dock', toggle: 'toggle-map-categories', content: 'filters', label: '地点分类' },
];

// The HUD has its own preferences; folding never changes a route or a filter.
export function setupMapHud(host = globalThis.window) {
  const doc = host?.document, listeners = [];
  if (!doc?.getElementById) return { destroy() {} };

  let compact = false, saved = {};
  try { compact = Boolean(host.matchMedia?.('(max-width: 600px), (max-height: 500px)').matches); } catch { /* A host without media queries uses the desktop default. */ }
  try {
    const value = JSON.parse(host.localStorage?.getItem(STORAGE_KEY) || 'null');
    if (value && typeof value === 'object' && !Array.isArray(value)) saved = value;
  } catch { /* Private browsing and older preferences must not disable the controls. */ }
  const expanded = Object.fromEntries(GROUPS.map(({ key }) => [key, typeof saved[key] === 'boolean' ? saved[key] : !compact]));

  for (const group of GROUPS) {
    const dock = doc.getElementById(group.dock), toggle = doc.getElementById(group.toggle), content = doc.getElementById(group.content);
    if (!dock || !toggle || !content) continue;
    function render() {
      const open = expanded[group.key];
      if (!open && doc.activeElement && content.contains?.(doc.activeElement)) toggle.focus();
      content.hidden = !open;
      dock.dataset.collapsed = String(!open);
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-controls', group.content);
      toggle.setAttribute('aria-label', `${open ? '收起' : '展开'}${group.label}`);
      toggle.setAttribute('title', `${open ? '收起' : '展开'}${group.label}`);
    }
    const onClick = () => {
      expanded[group.key] = !expanded[group.key];
      render();
      try { host.localStorage?.setItem(STORAGE_KEY, JSON.stringify(expanded)); } catch { /* Keep the current interaction usable if saving is blocked. */ }
    };
    render();
    toggle.addEventListener('click', onClick);
    listeners.push(() => toggle.removeEventListener('click', onClick));
  }

  return { destroy() { for (const remove of listeners.splice(0)) remove(); } };
}
