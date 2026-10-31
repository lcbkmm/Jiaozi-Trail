import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { insist } from '../domain/errors.js';
export class FileStore {
  constructor(config) { this.config=config;this.dir=path.join(config.dataDir,'media'); }
  location(id) { insist(/^[a-f0-9-]{36}\.png$/.test(id),'MEDIA_INVALID','图片标识无效');return path.join(this.dir,id); }
  async put(bytes) {
    await fs.mkdir(this.dir,{recursive:true});const id=`${randomUUID()}.png`,destination=this.location(id),temporary=destination+'.tmp';
    try { await fs.writeFile(temporary,bytes,{flag:'wx'});await fs.rename(temporary,destination); }
    catch(error) { await fs.rm(temporary,{force:true});throw error; }return id;
  }
  get(id) { return fs.readFile(this.location(id)); }
  remove(id) { return id?fs.rm(this.location(id),{force:true}):Promise.resolve(); }
  signature(user,id,expires) { return createHmac('sha256',this.config.mediaSecret).update(`${user}\n${id}\n${expires}`).digest('hex'); }
  url(user,id) {
    if(!id)return null;
    const exp=Math.floor(this.config.clock()/1000)+this.config.mediaTtlSeconds;
    return `${this.config.publicUrl}/api/digital-jiaozi/v1/media/${id}?u=${encodeURIComponent(user)}&e=${exp}&s=${this.signature(user,id,exp)}`;
  }
  verify(user,id,expires,signature) {
    const now=Math.floor(this.config.clock()/1000),exp=Number(expires);
    if(!Number.isInteger(exp)||exp<now||exp>now+this.config.mediaTtlSeconds||!/^[a-f0-9]{64}$/.test(signature||'')) return false;
    return timingSafeEqual(Buffer.from(this.signature(user,id,exp)),Buffer.from(signature));
  }
}
