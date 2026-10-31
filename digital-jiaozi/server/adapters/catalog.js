// Demo fixtures only. Production must inject the team's trusted activity/catalog adapter.
export const demoActivity = {
  id: 'chengdu_demo', name: '成都记忆 · 演示活动', startsAt: 0, endsAt: 4102444800000,
  places: ['春熙路','太古里','宽窄巷子','人民公园','锦里','杜甫草堂','安顺廊桥','东郊记忆','望江楼','文殊院'].map((name, i) => ({ id: `place-${i + 1}`, name, assetId: `C${String(i+1).padStart(2,'0')}` })),
  merchants: ['merchant-1','merchant-2','merchant-3','merchant-4'],
  tasks: ['culture-1','culture-2','culture-3'],
  routes: [{ id: 'route-1', placeIds: ['place-1','place-2','place-3'] }]
};
export const demoCatalog = { getActivity(id) { return id === demoActivity.id ? demoActivity : null; } };
export const rewardSeeds = [
  ['postcard','成都主题明信片',60,0,'E01'], ['magnet','成都主题冰箱贴',120,0,'E02'],
  ['keychain','成都创意钥匙扣',180,0,'E03'], ['physical-card','固定款实体纪念交子卡',200,600,'E04'],
  ['panda','熊猫玩偶',300,0,'E05']
].map(([id,title,cost,minimum,assetId]) => ({ id,title,cost,minimum,assetId, pointId:'demo-desk', demo:true, startsAt:0,endsAt:4102444800000,limit:1 }));
