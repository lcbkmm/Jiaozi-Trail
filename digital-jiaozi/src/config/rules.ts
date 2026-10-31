export const ACTIVITY = { id: 'six-landmarks-2026-v1', name: '六景旅记 · Demo', reward: 10, maxLandmarks: 6 } as const;
export const GIFTS = [
  { id: 'gift-charm', title: '胸章 / 小挂件', cost: 20, symbol: '✦', description: '一件可以随身携带的小记忆' },
  { id: 'gift-magnet', title: '普通主题冰箱贴', cost: 30, symbol: '▧', description: '把旅行的一角带回日常' },
  { id: 'gift-keepsake', title: '纪念小物', cost: 40, symbol: '◇', description: '留给这次出发的纪念' },
  { id: 'gift-panda', title: '熊猫玩偶', cost: 50, symbol: '◕', description: '陪伴旅程的软绵绵伙伴' },
  { id: 'gift-nfc', title: 'NFC 实体纪念交子冰箱贴', cost: 60, symbol: '⌁', description: '固定款纪念礼品，轻碰后打开本地旅程入口' }
] as const;
export const STORAGE_PREFIX = 'digital-jiaozi:';
export const PERSONAL_DB = STORAGE_PREFIX + 'personal';
export const SAMPLE_DB = STORAGE_PREFIX + 'sample';
