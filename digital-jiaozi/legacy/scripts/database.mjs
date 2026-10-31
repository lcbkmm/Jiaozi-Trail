import { createDigitalJiaozi } from '../server/index.js';
import { seedDemo } from './seed-demo.mjs';
const m=await createDigitalJiaozi(),action=process.argv[2];
try {
  if(action==='reset') {
    if(!m.config.demo)throw new Error('只允许在显式演示模式中重置');
    m.repo.transaction(()=>{
      for(const table of ['tokens','orders','ledger','stamps','events','receipts','business','jobs','idempotency','sessions','wallets','rewards'])m.repo.run(`DELETE FROM dj_${table}`);
    });
    // Intentional: reset database only. Orphan files are cleaned by maintenance, never rm -r user paths.
    m.commerce.seedRewards();
  }
  if(action==='seed'||action==='reset')await seedDemo(m);
  console.log(action==='migrate'?'dj_ 表迁移完成':'演示种子完成；demo-a 从零领取，demo-b 具有 590 分合法历史流水');
} finally {m.repo.close();}
