import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { rules } from '../config.js';
import { insist, shanghaiDay } from './errors.js';
export const draftSchema=z.object({title:z.string().trim().min(1).max(12),category:z.enum(['building','food','person','other']),crop:z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1),size:z.number().min(0.001).max(1)}).strict(),mode:z.enum(['tone','outline']),polarity:z.enum(['dark','light']),threshold:z.number().int().min(25).max(230)}).strict();
export class PhotoJobs {
  constructor(repo,config,commerce,files,renderer,vision) { Object.assign(this,{repo,config,commerce,files,renderer,vision});this.locks=new Set(); }
  owned(user,id) { const j=this.repo.one('SELECT * FROM dj_jobs WHERE id=? AND user_id=?',id,user);insist(j,'NOT_FOUND','任务不存在',404);return j; }
  view(user,id) {
    const j=this.owned(user,id);
    return {id:j.id,activityId:j.activity_id,status:j.status,analysisStatus:j.analysis_status,analysis:j.analysis?JSON.parse(j.analysis):null,error:j.error,draft:JSON.parse(j.draft),width:j.width,height:j.height,
      photoUrl:this.files.url(user,j.original),previewUrl:this.files.url(user,j.preview_file),resultUrl:this.files.url(user,j.result_file),
      namingSource:j.analysis_status==='SUCCEEDED'?'AI 辅助命名·照片处理生成':'手动命名·照片处理生成',
      attached:!!this.repo.one("SELECT id FROM dj_stamps WHERE user_id=? AND source='PHOTO_CUSTOM' AND source_id=?",user,id),aiEnabled:!!this.config.ai.key};
  }
  async upload(user,activity,bytes,key) {
    this.commerce.activity(activity);this.commerce.wallet(user,activity);
    // An upload retry with the same key/bytes returns its original job, not another draft.
    const input={activity,hash:(await import('./commerce.js')).digest(bytes)};
    const old=this.repo.one('SELECT * FROM dj_idempotency WHERE scope=? AND key=?',`upload:${user}`,key||'');
    if(old) { const id=this.commerce.idem(`upload:${user}`,key,input,()=>null);return this.view(user,id); }
    const normalized=await this.renderer.normalize(bytes),file=await this.files.put(normalized.bytes),id=randomUUID(),now=this.config.clock();
    try {
      const actual=this.repo.transaction(()=>this.commerce.idem(`upload:${user}`,key,input,()=>{
        const crop={x:(normalized.width-Math.min(normalized.width,normalized.height))/(2*normalized.width),y:(normalized.height-Math.min(normalized.width,normalized.height))/(2*normalized.height),size:1};
        const draft={title:'旅途记忆',category:'other',crop,mode:'tone',polarity:'dark',threshold:140};
        this.repo.run('INSERT INTO dj_jobs(id,user_id,activity_id,status,original,width,height,draft,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',id,user,activity,'DRAFT',file,normalized.width,normalized.height,JSON.stringify(draft),now,now);return id;
      }));
      if(actual!==id)await this.files.remove(file);return this.view(user,actual);
    } catch(error) {await this.files.remove(file);throw error;}
  }
  editable(job) { insist(!['READY','GENERATING','ANALYZING'].includes(job.status),'JOB_LOCKED','该任务正在处理或已定稿，请等待或新建草稿',409);insist(job.original,'PHOTO_EXPIRED','原照片已过保存期，请重新选择照片',410); }
  async exclusive(id,fn) {
    insist(!this.locks.has(id),'JOB_BUSY','该任务正在处理，请稍后查询',409);this.locks.add(id);
    try {return await fn();} finally {this.locks.delete(id);}
  }
  async draft(user,id,input) {
    return this.exclusive(id,async()=>{
      const job=this.owned(user,id);this.editable(job);const draft=draftSchema.parse(input);
      const bytes=await this.renderer.render(await this.files.get(job.original),draft),file=await this.files.put(bytes);
      this.repo.run("UPDATE dj_jobs SET draft=?,preview_file=?,status='AWAITING_CONFIRMATION',error=NULL,updated_at=? WHERE id=?",JSON.stringify(draft),file,this.config.clock(),id);
      await this.files.remove(job.preview_file);return this.view(user,id);
    });
  }
  async rotate(user,id) {
    return this.exclusive(id,async()=>{
      const j=this.owned(user,id);this.editable(j);
      const rotated=await this.renderer.rotate(await this.files.get(j.original)),file=await this.files.put(rotated);
      const d=JSON.parse(j.draft),width=j.height,height=j.width,min=Math.min(width,height);
      d.crop={x:(width-min)/(2*width),y:(height-min)/(2*height),size:1};
      this.repo.run("UPDATE dj_jobs SET original=?,width=?,height=?,draft=?,preview_file=NULL,status='DRAFT',updated_at=? WHERE id=?",file,width,height,JSON.stringify(d),this.config.clock(),id);
      await this.files.remove(j.original);await this.files.remove(j.preview_file);return this.view(user,id);
    });
  }
  async analyze(user,id) {
    return this.exclusive(id,async()=>{
      const j=this.owned(user,id);this.editable(j);
      this.repo.run("UPDATE dj_jobs SET status='ANALYZING',analysis_status='ANALYZING',error=NULL,updated_at=? WHERE id=?",this.config.clock(),id);
      try {
        const result=await this.vision.analyzePhoto(await this.files.get(j.original));
        this.repo.run("UPDATE dj_jobs SET status='AWAITING_CONFIRMATION',analysis_status='SUCCEEDED',analysis=?,updated_at=? WHERE id=?",JSON.stringify(result),this.config.clock(),id);
      } catch(error) {
        this.repo.run("UPDATE dj_jobs SET status='AWAITING_CONFIRMATION',analysis_status='FAILED',error=?,updated_at=? WHERE id=?",error.message,this.config.clock(),id);
      }
      return this.view(user,id);
    });
  }
  async generate(user,id,key) {
    const j=this.owned(user,id);this.commerce.activity(j.activity_id);
    if(j.status==='READY')return this.view(user,id);
    return this.exclusive(id,async()=>{
      this.repo.transaction(()=>{
        const j=this.owned(user,id);
        insist(['AWAITING_CONFIRMATION','FAILED'].includes(j.status),'PREVIEW_REQUIRED','请先确认裁剪和生成预览',409);
        insist(j.preview_file,'PREVIEW_REQUIRED','请先生成真实照片预览',409);
        insist(typeof key==='string'&&key.length>=8,'IDEMPOTENCY_REQUIRED','需要幂等键');
        const day=shanghaiDay(this.config.clock()),count=this.repo.one("SELECT COUNT(*) n FROM dj_jobs WHERE user_id=? AND (success_day=? OR (status='GENERATING' AND reserved_day=?))",user,day,day).n;
        insist(count<rules.photoDailyLimit,'PHOTO_DAILY_LIMIT','今日已成功生成或正在生成 3 枚，请明日再来',409);
        this.repo.run("UPDATE dj_jobs SET status='GENERATING',reserved_day=?,lease_until=?,error=NULL,updated_at=? WHERE id=?",day,this.config.clock()+120000,this.config.clock(),id);
      });
      let file;
      try {
        // Exact preview bytes are promoted to final: composition and parameters cannot drift.
        const current=this.owned(user,id);file=await this.files.put(await this.files.get(current.preview_file));
        this.repo.transaction(()=>{
          const day=shanghaiDay(this.config.clock());
          const count=this.repo.one("SELECT COUNT(*) n FROM dj_jobs WHERE user_id=? AND id<>? AND (success_day=? OR (status='GENERATING' AND reserved_day=?))",user,id,day,day).n;
          insist(count<rules.photoDailyLimit,'PHOTO_DAILY_LIMIT','跨日后今日额度已满，本次未扣次数，可稍后重试',409);
          this.repo.run("UPDATE dj_jobs SET status='READY',result_file=?,success_day=?,reserved_day=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='GENERATING'",file,day,this.config.clock(),id);
        });
      } catch(error) {
        await this.files.remove(file);
        this.repo.run("UPDATE dj_jobs SET status='FAILED',error='照片生成失败，可重试；未扣成功次数',reserved_day=NULL,lease_until=NULL,updated_at=? WHERE id=?",this.config.clock(),id);
        throw error;
      }
      return this.view(user,id);
    });
  }
  attach(user,id) {
    const j=this.owned(user,id);this.commerce.activity(j.activity_id);
    return this.repo.transaction(()=>{
      const j=this.owned(user,id);insist(j.status==='READY'&&j.result_file,'JOB_NOT_READY','印章尚未生成',409);const d=JSON.parse(j.draft);
      this.repo.run('INSERT OR IGNORE INTO dj_stamps(user_id,activity_id,source,source_id,title,file_id,created_at) VALUES(?,?,?,?,?,?,?)',user,j.activity_id,'PHOTO_CUSTOM',id,d.title,j.result_file,this.config.clock());
      return {attached:true,jobId:id,activityId:j.activity_id};
    });
  }
  async recover() {
    // Standalone is a single worker. Multi-worker hosts must replace this with lease-owner recovery.
    this.repo.run("UPDATE dj_jobs SET status='FAILED',reserved_day=NULL,lease_until=NULL,error='服务重启中断生成，可重试；未扣成功次数' WHERE status='GENERATING'");
    this.repo.run("UPDATE dj_jobs SET status='AWAITING_CONFIRMATION',analysis_status='FAILED',error='识别被服务重启中断，可手动继续' WHERE status='ANALYZING'");
    await this.cleanup();
  }
  async cleanup() {
    const cutoff=this.config.clock()-this.config.originalRetentionHours*3600000;
    const rows=this.repo.all("SELECT * FROM dj_jobs WHERE updated_at<? AND status NOT IN ('GENERATING','ANALYZING')",cutoff);
    for(const j of rows) {
      if(this.locks.has(j.id))continue;
      await this.exclusive(j.id,async()=>{
        const current=this.owned(j.user_id,j.id);if(current.updated_at>=cutoff)return;
        this.repo.run('UPDATE dj_jobs SET original=NULL,preview_file=NULL WHERE id=?',j.id);
        await this.files.remove(current.original);await this.files.remove(current.preview_file);
      });
    }
    // Only the local adapter exposes a directory; external stores own their garbage collection.
    if(!this.files.dir)return;
    const referenced=new Set(this.repo.all('SELECT original,preview_file,result_file FROM dj_jobs').flatMap(j=>[j.original,j.preview_file,j.result_file]));
    for(const row of this.repo.all('SELECT file_id FROM dj_stamps WHERE file_id IS NOT NULL'))referenced.add(row.file_id);
    const names=await fs.readdir(this.files.dir).catch(()=>[]);
    for(const name of names) {
      if(!/^[a-f0-9-]{36}\.png$/.test(name)||referenced.has(name))continue;
      const stat=await fs.stat(this.files.location(name)).catch(()=>null);
      if(stat&&stat.mtimeMs<cutoff)await this.files.remove(name);
    }
  }
}
