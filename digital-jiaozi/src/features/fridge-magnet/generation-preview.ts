export type PreviewKind = 'generating' | 'unconfirmed' | 'draft' | 'failed';

// The provider returns one final image, without intermediate frames or progress events.
// Keep this waiting estimate below completion until the returned image has been decoded.
export function estimatedGenerationProgress(startedAt: number, now = Date.now()) {
  return Math.min(95, Math.round(95 * (1 - Math.exp(-Math.max(0, now - startedAt) / 28000))));
}

export function generationPreview(kind: PreviewKind, workId: string) {
  const id = workId.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const labels = {
    generating: ['正在生成图片', '预计进度'],
    unconfirmed: ['等待确认结果', '可查询本次生成结果'],
    draft: ['照片草稿', '尚未生成'],
    failed: ['生成未完成', '照片已保留']
  };
  const [label, caption] = labels[kind];
  return `<div class="dj-generation-preview" data-magnet-generation="${id}" data-generation-state="${kind}">
    <div class="dj-generation-dots" aria-hidden="true"><i></i><i></i></div>
    <div class="dj-generation-copy">${kind === 'generating' ? '<strong class="dj-generation-percent" data-generation-percent>0%</strong>' : '<span class="dj-generation-symbol" aria-hidden="true">◇</span>'}
      <span class="dj-generation-label" data-generation-label>${label}</span><small data-generation-caption>${caption}</small>
      ${kind === 'generating' ? '<div class="dj-generation-track" role="progressbar" aria-label="图片生成预计进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i data-generation-fill></i></div>' : ''}
    </div></div>`;
}
