import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { z } from 'zod';
import { rules } from '../config.js';
import { insist, shanghaiDay } from '../domain/errors.js';
import { secretMatches } from '../adapters/auth.js';
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:rules.maxUploadBytes,files:1,fields:1,parts:2}});
const idString=z.string().min(1).max(120);
const eventSchema=z.object({eventId:idString,type:z.enum(['checkin.verified','purchase.verified','culture_task.completed','route.completed']),userId:idString,activityId:idString,occurredAt:z.iso.datetime(),source:z.object({recordId:idString,placeId:idString.optional(),merchantId:idString.optional(),orderId:idString.optional(),taskId:idString.optional(),routeId:idString.optional(),placeIds:z.array(idString).max(100).optional()}).strict()}).strict();
export function createRouter(module) {
  const {repo,config,commerce,jobs,files,auth,authenticate,verifyInternal}=module;
  const router=express.Router();router.use(express.json({limit:'32kb'}));
  const send=(res,data)=>res.json({code:'OK',message:'成功',data,serverTime:config.clock()});
  router.get('/health',(_req,res)=>send(res,{module:'digital-jiaozi',demo:config.demo}));
  router.post('/demo/session',(req,res)=>{
    const b=z.object({account:z.enum(['demo-a','demo-b','staff']),staffSecret:z.string().optional()}).strict().parse(req.body);
    send(res,auth.login(b.account,b.staffSecret));
  });
  router.post('/internal/reward-events',async(req,res)=>{
    const issuer=verifyInternal?await verifyInternal(req):secretMatches(req.headers['x-dj-internal-secret'],config.internalSecret)?'team':null;
    insist(issuer,'INTERNAL_FORBIDDEN','内部事件来源鉴权失败',403);
    send(res,commerce.event(eventSchema.parse(req.body),String(issuer)));
  });
  router.get('/media/:id',async(req,res)=>{
    const {u,e,s}=req.query;
    insist(typeof u==='string'&&files.verify(u,req.params.id,e,s),'MEDIA_FORBIDDEN','图片地址已过期或无权访问',403);
    const belongs=repo.one('SELECT id FROM dj_jobs WHERE user_id=? AND (original=? OR preview_file=? OR result_file=?)',u,req.params.id,req.params.id,req.params.id);
    insist(belongs,'NOT_FOUND','图片不存在',404);
    res.set({'Content-Type':'image/png','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}).send(await files.get(req.params.id));
  });
  router.use(async(req,_res,next)=>{
    const identity=await authenticate(req);insist(identity&&typeof identity.userId==='string','UNAUTHENTICATED','请先登录',401);req.identity=identity;next();
  });
  router.get('/session',(req,res)=>send(res,{identity:req.identity,demo:config.demo}));
  router.post('/wallets/initialize',(req,res)=>{const b=z.object({activityId:idString}).strict().parse(req.body);send(res,decorate(commerce.initialize(req.identity.userId,b.activityId),req.identity.userId));});
  const decorate=(overview,user)=>({...overview,stamps:overview.stamps.map(s=>({...s,imageUrl:s.fileId?files.url(user,s.fileId):null}))});
  router.get('/activities/:a/overview',(req,res)=>send(res,decorate(commerce.overview(req.identity.userId,req.params.a),req.identity.userId)));
  router.patch('/activities/:a/jiaozi',(req,res)=>{
    const b=z.object({title:z.string().trim().min(1).max(20)}).strict().parse(req.body);commerce.wallet(req.identity.userId,req.params.a);
    repo.run('UPDATE dj_wallets SET title=? WHERE user_id=? AND activity_id=?',b.title,req.identity.userId,req.params.a);send(res,{title:b.title});
  });
  router.post('/activities/:a/daily-checkin',(req,res)=>send(res,commerce.daily(req.identity.userId,req.params.a)));
  router.get('/activities/:a/tasks',(req,res)=>send(res,commerce.tasks(req.identity.userId,req.params.a)));
  router.get('/activities/:a/points/ledger',(req,res)=>{
    commerce.wallet(req.identity.userId,req.params.a);
    const q=z.object({cursor:z.coerce.number().int().positive().optional(),kind:z.enum(['EARN','SPEND','REFUND']).optional(),limit:z.coerce.number().int().min(1).max(50).default(20)}).parse(req.query);
    const rows=repo.all('SELECT id,kind,delta,source_type AS sourceType,source_id AS sourceId,created_at AS createdAt FROM dj_ledger WHERE user_id=? AND activity_id=? AND id<? AND (? IS NULL OR kind=?) ORDER BY id DESC LIMIT ?',req.identity.userId,req.params.a,q.cursor||Number.MAX_SAFE_INTEGER,q.kind||null,q.kind||null,q.limit+1);
    send(res,{items:rows.slice(0,q.limit),nextCursor:rows.length>q.limit?rows[q.limit-1].id:null});
  });
  router.post('/demo/events',(req,res)=>{
    insist(config.demo,'DEMO_DISABLED','演示入口已关闭',404);
    const b=z.object({activityId:idString,type:eventSchema.shape.type,placeId:idString.optional(),merchantId:idString.optional(),taskId:idString.optional(),routeId:idString.optional()}).strict().parse(req.body);
    const a=commerce.activity(b.activityId),now=config.clock(),source={recordId:`demo-${crypto.randomUUID()}`};
    if(b.placeId)source.placeId=b.placeId;if(b.merchantId) {source.merchantId=b.merchantId;source.orderId=`demo-order-${req.identity.userId}-${b.merchantId}-${shanghaiDay(now)}`;}
    if(b.taskId)source.taskId=b.taskId;if(b.routeId){source.routeId=b.routeId;source.placeIds=a.routes.find(r=>r.id===b.routeId)?.placeIds||[];}
    send(res,commerce.event({eventId:crypto.randomUUID(),type:b.type,userId:req.identity.userId,activityId:b.activityId,occurredAt:new Date(now).toISOString(),source},'demo'));
  });
  router.post('/activities/:a/stamp-jobs',upload.single('photo'),async(req,res)=>{
    insist(req.file,'PHOTO_REQUIRED','请选择照片');send(res,await jobs.upload(req.identity.userId,req.params.a,req.file.buffer,req.headers['idempotency-key']));
  });
  router.get('/activities/:a/stamp-jobs',(req,res)=>{
    commerce.wallet(req.identity.userId,req.params.a);
    send(res,repo.all('SELECT id FROM dj_jobs WHERE user_id=? AND activity_id=? ORDER BY created_at DESC LIMIT 30',req.identity.userId,req.params.a).map(j=>jobs.view(req.identity.userId,j.id)));
  });
  router.get('/stamp-jobs/:id',(req,res)=>send(res,jobs.view(req.identity.userId,req.params.id)));
  router.patch('/stamp-jobs/:id/draft',async(req,res)=>send(res,await jobs.draft(req.identity.userId,req.params.id,req.body)));
  router.post('/stamp-jobs/:id/rotate',async(req,res)=>send(res,await jobs.rotate(req.identity.userId,req.params.id)));
  router.post('/stamp-jobs/:id/analyze',async(req,res)=>send(res,await jobs.analyze(req.identity.userId,req.params.id)));
  router.post('/stamp-jobs/:id/generate',async(req,res)=>send(res,await jobs.generate(req.identity.userId,req.params.id,req.headers['idempotency-key'])));
  router.post('/stamp-jobs/:id/attach',(req,res)=>send(res,jobs.attach(req.identity.userId,req.params.id)));
  router.get('/activities/:a/rewards',(req,res)=>send(res,commerce.rewards(req.identity.userId,req.params.a)));
  router.post('/activities/:a/redemptions',(req,res)=>{
    const b=z.object({rewardItemId:idString}).strict().parse(req.body);send(res,commerce.createOrder(req.identity.userId,req.params.a,b.rewardItemId,req.headers['idempotency-key']));
  });
  router.get('/activities/:a/redemptions',(req,res)=>{
    commerce.wallet(req.identity.userId,req.params.a);commerce.expire(req.identity.userId);
    const cursor=z.coerce.number().int().positive().optional().parse(req.query.cursor);
    const items=repo.all('SELECT * FROM dj_orders WHERE user_id=? AND activity_id=? AND rowid<? ORDER BY rowid DESC LIMIT 21',req.identity.userId,req.params.a,cursor||Number.MAX_SAFE_INTEGER);
    // Stable cursor uses created_at+id via rowid fetched separately to avoid exposing user fields in generic pagers.
    const shown=items.slice(0,20),last=shown.at(-1);
    send(res,{items:shown,nextCursor:items.length>20?repo.one('SELECT rowid n FROM dj_orders WHERE id=?',last.id).n:null});
  });
  router.get('/redemptions/:id',(req,res)=>{commerce.expire(req.identity.userId);send(res,commerce.order(req.identity.userId,req.params.id));});
  router.post('/redemptions/:id/cancel',(req,res)=>send(res,commerce.cancel(req.identity.userId,req.params.id)));
  router.post('/redemptions/:id/token',async(req,res)=>{
    const t=commerce.token(req.identity.userId,req.params.id);send(res,{...t,qrDataUrl:await QRCode.toDataURL(t.token,{errorCorrectionLevel:'M',width:480,margin:4})});
  });
  router.post('/staff/redemptions/inspect',(req,res)=>{const b=z.object({token:z.string().min(10).max(100)}).strict().parse(req.body);send(res,commerce.staffToken(req.identity,b.token));});
  router.post('/staff/redemptions/verify',(req,res)=>{const b=z.object({token:z.string().min(10).max(100)}).strict().parse(req.body);send(res,commerce.staffToken(req.identity,b.token,true));});
  router.use((_req,_res,next)=>next(Object.assign(new Error('接口不存在'),{status:404,code:'NOT_FOUND'})));
  router.use((error,_req,res,_next)=>{
    if(error instanceof z.ZodError) return res.status(400).json({code:'INVALID_INPUT',message:'参数格式不符合接口契约',data:{issues:error.issues.map(i=>({path:i.path,message:i.message}))},serverTime:config.clock()});
    const status=error.code==='LIMIT_FILE_SIZE'?413:error.status|| (error instanceof multer.MulterError?400:500);
    res.status(status).json({code:error.code==='LIMIT_FILE_SIZE'?'UPLOAD_TOO_LARGE':error.status?error.code:'INTERNAL_ERROR',message:status>=500?'处理暂时失败，请重试':error.message,data:null,serverTime:config.clock()});
  });
  return router;
}
