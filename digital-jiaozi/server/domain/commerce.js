import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rules } from '../config.js';
import { insist, shanghaiDay } from './errors.js';
import { rewardSeeds } from '../adapters/catalog.js';
export const digest = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const fingerprint = value => digest(JSON.stringify(canonical(value)));
export class Commerce {
  constructor(repo, config, catalog) { this.repo = repo; this.config = config; this.catalog = catalog; }
  activity(id, active = true) {
    const a = this.catalog.getActivity(id);
    insist(a, 'ACTIVITY_NOT_FOUND', '活动不存在', 404);
    if (active) insist(this.config.clock() >= a.startsAt && this.config.clock() < a.endsAt, 'ACTIVITY_CLOSED', '活动不在开放期');
    return a;
  }
  wallet(user, activity) {
    const w = this.repo.one('SELECT * FROM dj_wallets WHERE user_id=? AND activity_id=?',user,activity);
    insist(w,'WALLET_REQUIRED','请先领取地图交子',409); return w;
  }
  idem(scope, key, input, fn) {
    insist(typeof key === 'string' && key.length >= 8 && key.length <= 160,'IDEMPOTENCY_REQUIRED','需要 8–160 字符幂等键');
    const hash = fingerprint(input), old = this.repo.one('SELECT * FROM dj_idempotency WHERE scope=? AND key=?',scope,key);
    if (old) { insist(old.fingerprint===hash,'IDEMPOTENCY_CONFLICT','同一请求键不能用于不同输入',409); return JSON.parse(old.result); }
    const result = fn();
    this.repo.run('INSERT INTO dj_idempotency VALUES(?,?,?,?)',scope,key,hash,JSON.stringify(result)); return result;
  }
  earn(user, activity, points, type, source, dedup, at = this.config.clock()) {
    const insert = this.repo.run('INSERT OR IGNORE INTO dj_ledger(user_id,activity_id,kind,delta,source_type,source_id,dedup,day,created_at) VALUES(?,?,?,?,?,?,?,?,?)',user,activity,'EARN',points,type,source,dedup,shanghaiDay(at),at);
    if (!insert.changes) return 0;
    this.repo.run('UPDATE dj_wallets SET lifetime=lifetime+?, available=available+?, unlocked_at=CASE WHEN lifetime+?>=? THEN COALESCE(unlocked_at,?) ELSE unlocked_at END WHERE user_id=? AND activity_id=?',points,points,points,rules.stages.at(-1).threshold,at,user,activity);
    return points;
  }
  initialize(user, activity) {
    this.activity(activity);
    this.repo.transaction(() => {
      this.repo.run('INSERT OR IGNORE INTO dj_wallets(user_id,activity_id,title,serial) VALUES(?,?,?,?)',user,activity,'我的成都记忆',randomUUID().slice(0,8).toUpperCase());
      this.earn(user,activity,rules.rewards.initialize,'initialize',activity,'initialize');
    });
    return this.overview(user,activity);
  }
  daily(user, activity) {
    this.activity(activity); this.wallet(user,activity);
    const day=shanghaiDay(this.config.clock());
    const awarded=this.repo.transaction(()=>this.earn(user,activity,rules.rewards.daily,'daily',day,`daily:${day}`));
    return { awarded, ...this.overview(user,activity) };
  }
  overview(user, activity) {
    const a=this.activity(activity,false);
    this.expire(user);
    const w=this.wallet(user,activity), stage=[...rules.stages].reverse().find(s=>w.lifetime>=s.threshold);
    const next=rules.stages.find(s=>s.threshold>w.lifetime);
    const physical=this.repo.one("SELECT status FROM dj_orders WHERE user_id=? AND activity_id=? AND reward_id='physical-card' AND status IN ('PENDING','REDEEMED')",user,activity);
    return { activityId:activity, activityName:a.name, demo:this.config.demo, title:w.title, serial:w.serial,
      lifetimePoints:w.lifetime,availablePoints:w.available,stage:stage.id,stageName:stage.name,stageColor:stage.color,
      nextThreshold:next?.threshold??null,progress:next?Math.min(100,Math.floor(100*(w.lifetime-stage.threshold)/(next.threshold-stage.threshold))):100,
      commemorativeUnlocked:!!w.unlocked_at,physicalCardStatus:physical?.status||(w.unlocked_at?'ELIGIBLE':'LOCKED'),
      stamps:this.repo.all('SELECT id,source,source_id AS sourceId,title,asset_id AS assetId,file_id AS fileId,created_at AS createdAt FROM dj_stamps WHERE user_id=? AND activity_id=? ORDER BY id',user,activity)
    };
  }
  tasks(user,activity) {
    const a=this.activity(activity,false); this.wallet(user,activity);
    const counts=Object.fromEntries(this.repo.all("SELECT source_type,COUNT(*) n FROM dj_ledger WHERE user_id=? AND activity_id=? AND day=? AND kind='EARN' GROUP BY source_type",user,activity,shanghaiDay(this.config.clock())).map(r=>[r.source_type,r.n]));
    const stamps=this.repo.all("SELECT source_id FROM dj_stamps WHERE user_id=? AND activity_id=? AND source='OFFICIAL'",user,activity).map(r=>r.source_id);
    const completed=this.repo.all('SELECT semantic FROM dj_business WHERE user_id=? AND activity_id=?',user,activity).map(r=>r.semantic);
    return {demo:this.config.demo, counts, caps:rules.dailyCaps,rewards:rules.rewards,places:a.places.map(p=>({...p,completed:stamps.includes(p.id)})),merchants:a.merchants,tasks:a.tasks,routes:a.routes,completed};
  }
  event(event, issuer) {
    const {userId:user,activityId:activity,type,source,eventId}=event;
    const a=this.activity(activity); this.wallet(user,activity);
    insist(rules.rewards[type]!==undefined && type.includes('.'),'EVENT_TYPE','不支持的业务事件');
    insist(Math.abs(this.config.clock()-Date.parse(event.occurredAt))<=7*86400000,'EVENT_TIME','事件时间须在服务端七日窗口内；历史导入走种子/专用迁移');
    const hash=fingerprint(event);
    return this.repo.transaction(()=>{
      const prior=this.repo.one('SELECT * FROM dj_events WHERE event_id=?',eventId);
      if(prior) { insist(prior.fingerprint===hash,'EVENT_CONFLICT','事件编号已用于不同内容',409); return {...JSON.parse(prior.result),awarded:0,duplicate:true}; }
      const sourceKey=`${issuer}:${type}:${source.orderId||source.recordId}`;
      const sourceHash=fingerprint({type,user,activity,source:{...source,recordId:source.orderId?undefined:source.recordId}});
      const receipt=this.repo.one('SELECT * FROM dj_receipts WHERE source_key=?',sourceKey);
      if(receipt) {
        insist(receipt.fingerprint===sourceHash,'SOURCE_CONFLICT','业务来源编号已用于不同内容',409);
        const result={...JSON.parse(receipt.result),awarded:0,duplicate:true};
        this.repo.run('INSERT INTO dj_events VALUES(?,?,?,?)',eventId,hash,JSON.stringify(result),this.config.clock());return result;
      }
      let semantic;
      const day=shanghaiDay(this.config.clock());
      if(type==='checkin.verified') { insist(a.places.some(p=>p.id===source.placeId),'PLACE_INVALID','不是本活动地点'); semantic=`place:${source.placeId}`; }
      if(type==='purchase.verified') { insist(a.merchants.includes(source.merchantId)&&source.orderId,'PURCHASE_INVALID','消费门店或订单无效'); semantic=`merchant:${source.merchantId}:${day}`; }
      if(type==='culture_task.completed') { insist(a.tasks.includes(source.taskId),'TASK_INVALID','不是本活动文化任务'); semantic=`culture:${source.taskId}`; }
      if(type==='route.completed') {
        const route=a.routes.find(r=>r.id===source.routeId), snapshot=[...new Set(source.placeIds||[])].sort();
        insist(route && new Set(route.placeIds).size>=3 && JSON.stringify([...route.placeIds].sort())===JSON.stringify(snapshot),'ROUTE_INVALID','路线快照不匹配或少于三个不同地点');
        const visited=this.repo.all("SELECT source_id FROM dj_stamps WHERE user_id=? AND activity_id=? AND source='OFFICIAL'",user,activity).map(s=>s.source_id);
        insist(snapshot.every(id=>visited.includes(id)),'ROUTE_INCOMPLETE','路线要求的地点尚未全部获得受信任打卡记录'); semantic='route:activity';
      }
      const seen=this.repo.one('SELECT * FROM dj_business WHERE source_key=? OR (user_id=? AND activity_id=? AND semantic=?)',sourceKey,user,activity,semantic);
      let result;
      if(seen) {
        insist(seen.user_id===user&&seen.activity_id===activity,'SOURCE_CONFLICT','该业务记录已绑定其他账户',409);
        result={...JSON.parse(seen.result),awarded:0,duplicate:true};
      } else {
        if(type==='checkin.verified') {
          const p=a.places.find(p=>p.id===source.placeId);
          this.repo.run('INSERT OR IGNORE INTO dj_stamps(user_id,activity_id,source,source_id,title,asset_id,created_at) VALUES(?,?,?,?,?,?,?)',user,activity,'OFFICIAL',p.id,p.name,p.assetId,this.config.clock());
        }
        const count=this.repo.one("SELECT COUNT(*) n FROM dj_ledger WHERE user_id=? AND activity_id=? AND day=? AND source_type=? AND kind='EARN'",user,activity,day,type).n;
        const capped=rules.dailyCaps[type]!==undefined&&count>=rules.dailyCaps[type];
        const awarded=capped?0:this.earn(user,activity,rules.rewards[type],type,source.recordId,`event:${semantic}`);
        result={awarded,duplicate:false,dailyCapped:capped,demo:issuer==='demo'};
        this.repo.run('INSERT INTO dj_business VALUES(?,?,?,?,?)',sourceKey,user,activity,semantic,JSON.stringify(result));
      }
      this.repo.run('INSERT INTO dj_receipts VALUES(?,?,?,?,?)',sourceKey,user,activity,sourceHash,JSON.stringify(result));
      this.repo.run('INSERT INTO dj_events VALUES(?,?,?,?)',eventId,hash,JSON.stringify(result),this.config.clock());
      return result;
    });
  }
  seedRewards(activity='chengdu_demo') {
    for(const r of rewardSeeds) this.repo.run('INSERT OR IGNORE INTO dj_rewards VALUES(?,?,?,?)',r.id,activity,JSON.stringify(r),10);
  }
  rewards(user,activity) {
    const a=this.activity(activity,false);this.expire(user);const w=this.wallet(user,activity),now=this.config.clock();
    return this.repo.all('SELECT * FROM dj_rewards WHERE activity_id=?',activity).map(row=>{
      const r=JSON.parse(row.data),existing=this.repo.one("SELECT id FROM dj_orders WHERE user_id=? AND activity_id=? AND reward_id=? AND status IN ('PENDING','REDEEMED')",user,activity,r.id);
      const reason=now<a.startsAt||now>=a.endsAt?'活动尚未开始或已结束':existing?'已有待领取或已领取订单':w.lifetime<r.minimum?'累计积分未达纪念门槛':row.stock<=0?'库存不足':w.available<r.cost?`还差 ${r.cost-w.available} 积分`:now<r.startsAt||now>=r.endsAt?'不在兑换期':'';
      return {...r,stock:row.stock,canRedeem:!reason,reason};
    });
  }
  order(user,id,staff=false) {
    const row=this.repo.one('SELECT * FROM dj_orders WHERE id=?',id);
    insist(row && (staff||row.user_id===user),'NOT_FOUND','订单不存在',404); return row;
  }
  transition(order, status) {
    const changed=this.repo.run("UPDATE dj_orders SET status=? WHERE id=? AND status='PENDING'",status,order.id).changes;
    if(changed) {
      this.repo.run('UPDATE dj_wallets SET available=available+? WHERE user_id=? AND activity_id=?',order.cost,order.user_id,order.activity_id);
      this.repo.run('UPDATE dj_rewards SET stock=stock+1 WHERE id=? AND activity_id=?',order.reward_id,order.activity_id);
      this.repo.run('INSERT INTO dj_ledger(user_id,activity_id,kind,delta,source_type,source_id,dedup,day,created_at) VALUES(?,?,?,?,?,?,?,?,?)',order.user_id,order.activity_id,'REFUND',order.cost,status,order.id,`refund:${order.id}`,shanghaiDay(this.config.clock()),this.config.clock());
    }
    return !!changed;
  }
  expire(user) {
    this.repo.transaction(()=>{
      const rows=user?this.repo.all("SELECT * FROM dj_orders WHERE status='PENDING' AND expires_at<=? AND user_id=?",this.config.clock(),user):this.repo.all("SELECT * FROM dj_orders WHERE status='PENDING' AND expires_at<=?",this.config.clock());
      rows.forEach(r=>this.transition(r,'EXPIRED'));
    });
  }
  createOrder(user,activity,rewardId,key) {
    this.activity(activity);this.expire(user);
    const id=this.repo.transaction(()=>this.idem(`order:${user}:${activity}`,key,{rewardId},()=>{
      const w=this.wallet(user,activity),item=this.repo.one('SELECT * FROM dj_rewards WHERE id=? AND activity_id=?',rewardId,activity);
      insist(item,'NOT_FOUND','商品不存在',404);const r=JSON.parse(item.data),now=this.config.clock();
      insist(now>=r.startsAt&&now<r.endsAt,'REWARD_CLOSED','不在商品兑换期');
      insist(w.lifetime>=r.minimum,'QUALIFICATION_REQUIRED','累计积分未达纪念门槛',409);
      insist(!this.repo.one("SELECT id FROM dj_orders WHERE user_id=? AND activity_id=? AND reward_id=? AND status IN ('PENDING','REDEEMED')",user,activity,rewardId),'LIMIT_REACHED','该商品每人每活动限兑一次，已有订单',409);
      insist(item.stock>0,'OUT_OF_STOCK','库存不足',409);insist(w.available>=r.cost,'INSUFFICIENT_POINTS','可用积分不足',409);
      const id=randomUUID();
      insist(this.repo.run('UPDATE dj_wallets SET available=available-? WHERE user_id=? AND activity_id=? AND available>=?',r.cost,user,activity,r.cost).changes,'INSUFFICIENT_POINTS','可用积分不足',409);
      insist(this.repo.run('UPDATE dj_rewards SET stock=stock-1 WHERE id=? AND activity_id=? AND stock>0',rewardId,activity).changes,'OUT_OF_STOCK','库存不足',409);
      this.repo.run('INSERT INTO dj_orders VALUES(?,?,?,?,?,?,?,?,?,?,NULL)',id,user,activity,rewardId,r.title,r.cost,r.pointId,'PENDING',now,now+(r.orderTtlMs||rules.orderTtlMs));
      this.repo.run('INSERT INTO dj_ledger(user_id,activity_id,kind,delta,source_type,source_id,dedup,day,created_at) VALUES(?,?,?,?,?,?,?,?,?)',user,activity,'SPEND',-r.cost,'redemption',id,`spend:${id}`,shanghaiDay(now),now);
      return id;
    }));return this.order(user,id);
  }
  cancel(user,id) {
    this.expire(user);
    return this.repo.transaction(()=>{
      const o=this.order(user,id);insist(o.status!=='REDEEMED','ALREADY_REDEEMED','已领取订单不能取消',409);
      if(o.status==='PENDING') this.transition(o,'CANCELLED');return this.order(user,id);
    });
  }
  token(user,id) {
    this.expire(user);
    return this.repo.transaction(()=>{
      const o=this.order(user,id);insist(o.status==='PENDING','ORDER_NOT_PENDING','订单已结束',409);
      const token=randomBytes(32).toString('base64url'),expiresAt=Math.min(this.config.clock()+rules.tokenTtlMs,o.expires_at);
      this.repo.run('UPDATE dj_tokens SET active=0 WHERE order_id=?',id);
      this.repo.run('INSERT INTO dj_tokens VALUES(?,?,?,1)',digest(token),id,expiresAt);
      return {token:`dj1:${token}`,expiresAt,orderExpiresAt:o.expires_at};
    });
  }
  staffToken(identity,token,confirm=false) {
    insist(identity.role==='staff','STAFF_REQUIRED','需要工作人员身份',403);this.expire();
    return this.repo.transaction(()=>{
      const t=this.repo.one('SELECT * FROM dj_tokens WHERE digest=?',digest(token.replace(/^dj1:/,'')));
      insist(t&&t.active,'TOKEN_INVALID','兑换码无效或已被刷新',409);
      const o=this.order(null,t.order_id,true);
      insist(identity.pointIds?.includes(o.point_id),'POINT_FORBIDDEN','无权在该兑换点核销',403);
      if(o.status==='REDEEMED') return {id:o.id,title:o.title,status:o.status,alreadyRedeemed:true,redeemedAt:o.redeemed_at};
      insist(o.status==='PENDING','ORDER_NOT_PENDING','订单已取消或到期',409);
      insist(t.expires_at>this.config.clock(),'TOKEN_EXPIRED','动态码已到期，请用户刷新',409);
      if(confirm) this.repo.run("UPDATE dj_orders SET status='REDEEMED',redeemed_at=? WHERE id=? AND status='PENDING'",this.config.clock(),o.id);
      return {id:o.id,title:o.title,pointId:o.point_id,status:confirm?'REDEEMED':o.status,cost:o.cost};
    });
  }
}
