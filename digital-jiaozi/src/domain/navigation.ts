export type View = 'home' | 'collection' | 'rewards' | 'journey' | 'photos';
export interface Navigation { view: View; journeyId?: string; tagId?: string; sample: boolean; error?: string }
// Only the integrated deployment has a known map sibling. Standalone demos do not.
export function mapReturnUrl(pageUrl: string): string | undefined {
  const url = new URL(pageUrl);
  if (!/\/assets\/digital-jiaozi\/(?:index\.html)?$/.test(url.pathname)) return undefined;
  return new URL('../../baidu-map.html', url).href;
}
export function parseRoute(hash: string, prefix = '/digital-jiaozi'): Navigation {
  const raw = hash.replace(/^#/, '') || prefix;
  const [path, query = ''] = raw.split('?'), params = new URLSearchParams(query);
  const suffix = path === prefix || path === prefix + '/' ? 'home' : path.startsWith(prefix + '/') ? path.slice(prefix.length + 1) : 'unknown';
  const known = ['home', 'collection', 'rewards', 'journey', 'photos'].includes(suffix);
  const view = known ? suffix as View : 'home';
  const unknown = [...params.keys()].find(k => !['journeyId', 'tagId', 'sample'].includes(k));
  const invalid = (params.has('journeyId') && !params.get('journeyId')) || (params.has('tagId') && !params.get('tagId')) || (params.has('sample') && params.get('sample') !== '1') || [...params.keys()].some(k => params.getAll(k).length > 1);
  return { view, journeyId: params.get('journeyId') || undefined, tagId: params.get('tagId') || undefined, sample: params.get('sample') === '1',
    error: !known ? '这个交子页面不存在，请从导航重新进入。' : unknown || invalid || raw.split('?').length > 2 ? '链接参数无法识别，请检查 NFC 中保存的网址。' : undefined };
}
export function journeyUrl(base: string, selector: { journeyId?: string; tagId?: string; sample?: boolean }, prefix = '/digital-jiaozi') {
  const url = new URL(base); url.hash = ''; const params = new URLSearchParams();
  if (selector.journeyId) params.set('journeyId', selector.journeyId);
  if (selector.tagId) params.set('tagId', selector.tagId);
  if (selector.sample) params.set('sample', '1');
  url.hash = prefix + '/journey' + (params.size ? '?' + params.toString() : ''); return url.href;
}
