const paths: Record<string, string> = {
  home: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 11h6M9 15h3"/>',
  collection: '<path d="m12 3 2.8 6.2L21 12l-6.2 2.8L12 21l-2.8-6.2L3 12l6.2-2.8Z"/>',
  gift: '<rect x="4" y="9" width="16" height="4" rx="1"/><path d="M5 13v7h14v-7M12 9v11M12 9C4 9 5 3 8 4c3 0 4 5 4 5Zm0 0c8 0 7-6 4-5-3 0-4 5-4 5Z"/>',
  camera: '<path d="M8 5h8l2 3h3v12H3V8h3Z"/><circle cx="12" cy="13" r="4"/>',
  journey: '<path d="M6 4h5a4 4 0 0 1 0 8H9a4 4 0 0 0 0 8h9M16 17l3 3-3 3"/><circle cx="4" cy="4" r="2"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>'
};
export const icon = (name: string) => `<svg class="dj-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.home}</svg>`;
