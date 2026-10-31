import { randomBytes, timingSafeEqual } from 'node:crypto';
import { digest } from '../domain/commerce.js';
import { insist } from '../domain/errors.js';
export const secretMatches=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.length>=16&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
export class DemoAuth {
  constructor(repo,config) { Object.assign(this,{repo,config}); }
  login(account,staffSecret) {
    insist(this.config.demo,'DEMO_DISABLED','演示入口已关闭',404);
    insist(['demo-a','demo-b','staff'].includes(account),'DEMO_ACCOUNT','未知演示身份');
    if(account==='staff')insist(secretMatches(staffSecret,this.config.staffSecret),'STAFF_LOGIN_FAILED','工作人员演示口令错误',403);
    const identity={userId:account,role:account==='staff'?'staff':'user',pointIds:account==='staff'?['demo-desk']:[],demo:true};
    const token=randomBytes(32).toString('base64url'),expiresAt=this.config.clock()+86400000;
    this.repo.run('INSERT INTO dj_sessions VALUES(?,?,?)',digest(token),JSON.stringify(identity),expiresAt);return {token,identity,expiresAt};
  }
  authenticate(req) {
    const token=(req.headers.authorization||'').replace(/^Bearer /,'');
    const s=this.repo.one('SELECT * FROM dj_sessions WHERE digest=? AND expires_at>?',digest(token),this.config.clock());
    insist(s,'UNAUTHENTICATED','请先登录',401);return JSON.parse(s.identity);
  }
}
