import express from 'express';
import { createDigitalJiaozi } from './index.js';
const module=await createDigitalJiaozi();
const app=express();app.disable('x-powered-by');app.use('/api/digital-jiaozi/v1',module.router);
const port=Number(process.env.DJ_PORT||3307);
const server=app.listen(port,'0.0.0.0',()=>console.log(`数字交子服务 ${module.config.publicUrl} · ${module.config.demo?'演示模式':'正式模式'}`));
const maintenance=setInterval(()=>{module.commerce.expire();module.jobs.cleanup().catch(()=>console.error('媒体清理失败，稍后重试'));},60000).unref();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{clearInterval(maintenance);server.close(()=>{module.repo.close();process.exit(0);});});
