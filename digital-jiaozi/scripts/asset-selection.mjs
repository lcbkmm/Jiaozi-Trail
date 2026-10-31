export function selectAsset(entry, decisions, supported) {
  if(!/^[B-G]\d{2}$/.test(entry.assetId)||!supported.includes(entry.assetId))return '非当前分包使用的正式编号';
  if(entry.selected!==true||typeof entry.targetPath!=='string'||!entry.targetPath.trim())return '未选中或无有效 targetPath';
  if(!['PASS','PASS_WITH_NOTE'].includes(entry.qaStatus))return '未通过正式验收';
  const decision=decisions[entry.assetId];
  if(!entry.qaNote?.trim()||!decision?.resolution?.trim()||decision.qaNote!==entry.qaNote)return '验收备注尚未明确处理，或备注已更新';
  return null;
}
