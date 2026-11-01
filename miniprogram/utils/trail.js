// 所有地点、步行时长、排队和奖励均为演示数据，不代表真实门店权益。
const PLACES = [
  { id: 'beauty', name: '花间美妆研究所', category: '美妆首发', label: 'BEAUTY', description: '试一抹新色，遇见今日的小惊喜', perk: '限定试用礼', cost: 30, stay: 25, queue: 10, x: 1, y: 1, tone: 'peach', symbol: '花' },
  { id: 'coffee', name: '慢半拍咖啡', category: '咖啡甜点', label: 'COFFEE', description: '一杯拿铁，留一点时间给自己', perk: '咖啡加购礼', cost: 48, stay: 40, queue: 8, x: 4, y: 3, tone: 'sage', symbol: '慢' },
  { id: 'design', name: '成都有礼', category: '城市好物', label: 'LOCAL FINDS', description: '把属于这座城的灵感装进口袋', perk: '城市印章', cost: 35, stay: 25, queue: 5, x: 6, y: 5, tone: 'sand', symbol: '礼' },
  { id: 'books', name: '转角书屋', category: '城市好物', label: 'BOOKS', description: '翻到喜欢的一页，就多坐一会儿', perk: '阅读打卡章', cost: 0, stay: 25, queue: 0, x: 2, y: 4, tone: 'sage', symbol: '书' },
  { id: 'brunch', name: '日光餐桌', category: '咖啡甜点', label: 'BRUNCH', description: '阳光和一份刚刚好的早午餐', perk: '餐后甜点礼', cost: 88, stay: 50, queue: 12, x: 5, y: 2, tone: 'peach', symbol: '日' },
  { id: 'gallery', name: '巷里小展', category: '城市好物', label: 'GALLERY', description: '沿着街巷，看看城市的新表达', perk: '展览纪念章', cost: 30, stay: 30, queue: 5, x: 7, y: 6, tone: 'sand', symbol: '巷' }
];

function walkingMinutes(from, to) {
  return (Math.abs(from.x - to.x) + Math.abs(from.y - to.y)) * 2;
}

function formatTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function planTrail(options) {
  const budget = Number(options.budget);
  const duration = Number(options.duration);
  const interests = options.interests || [];
  if (!Number.isFinite(budget) || budget < 0 || !Number.isFinite(duration) || duration <= 0) {
    return null;
  }
  let best = null;
  function visit(stops, cost, minutes, previous) {
    if (stops.length) {
      const categories = [...new Set(stops.map((stop) => stop.category))];
      const score = stops.length * 100 + categories.length * 25 +
        stops.filter((stop) => interests.indexOf(stop.category) !== -1).length * 20 - minutes / 100;
      if (!best || score > best.score) best = { stops, cost, minutes, score };
    }
    if (stops.length === 3) return;
    PLACES.forEach((place) => {
      if (stops.some((stop) => stop.id === place.id)) return;
      const walk = walkingMinutes(previous, place);
      const nextMinutes = minutes + walk + place.queue + place.stay;
      if (cost + place.cost > budget || nextMinutes > duration) return;
      visit(stops.concat(Object.assign({}, place, {
        walk,
        time: formatTime(13 * 60 + minutes + walk),
        checked: false
      })), cost + place.cost, nextMinutes, place);
    });
  }
  visit([], 0, 0, { x: 0, y: 0 });
  if (!best) return null;
  return { stops: best.stops, cost: best.cost, minutes: best.minutes };
}

function stampPlace(stamps, id) {
  if (!PLACES.some((place) => place.id === id) || stamps.indexOf(id) !== -1) return stamps.slice();
  return stamps.concat(id);
}

function walletState(stamps) {
  const places = PLACES.filter((place) => stamps.indexOf(place.id) !== -1);
  const categoryCount = new Set(places.map((place) => place.category)).size;
  return {
    count: places.length,
    categoryCount,
    progress: Math.round(categoryCount / 3 * 100),
    level: categoryCount >= 3 ? '联动交子' : places.length ? '进阶交子' : '基础交子',
    message: categoryCount >= 3 ? '三类足迹已集齐，联动交子已点亮' : `再探索 ${3 - categoryCount} 个品类，点亮联动交子`
  };
}

module.exports = { PLACES, planTrail, stampPlace, walletState };
