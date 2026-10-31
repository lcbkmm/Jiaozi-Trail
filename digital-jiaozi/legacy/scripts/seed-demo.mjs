import { randomUUID } from 'node:crypto';
export async function seedDemo(m) {
  if(!m.config.demo)throw new Error('正式环境禁止演示种子');
  if(m.repo.one("SELECT user_id FROM dj_wallets WHERE user_id='demo-b'"))return;
  const originalClock=m.config.clock,now=originalClock(),activity='chengdu_demo',user='demo-b';
  const event=(type,source)=>m.commerce.event({eventId:randomUUID(),type,userId:user,activityId:activity,occurredAt:new Date(m.config.clock()).toISOString(),source:{recordId:randomUUID(),...source}},'demo-seed');
  try {
    m.config.clock=()=>now-3*86400000;m.commerce.initialize(user,activity);m.commerce.daily(user,activity);
    for(let i=1;i<=5;i++)event('checkin.verified',{placeId:`place-${i}`});
    for(let i=1;i<=3;i++)event('purchase.verified',{merchantId:`merchant-${i}`,orderId:`history-purchase-${i}`});
    for(let i=1;i<=2;i++)event('culture_task.completed',{taskId:`culture-${i}`});
    m.config.clock=()=>now-2*86400000;m.commerce.daily(user,activity);event('checkin.verified',{placeId:'place-6'});
    m.config.clock=()=>now-86400000;m.commerce.daily(user,activity);
  }finally{m.config.clock=originalClock;}
  if(m.commerce.wallet(user,activity).lifetime!==590)throw new Error('种子流水合计异常');
}
