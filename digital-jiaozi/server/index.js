import { randomBytes } from 'node:crypto';
import { configuration } from './config.js';
import { Repository } from './repositories/sqlite.js';
import { Commerce } from './domain/commerce.js';
import { PhotoJobs } from './domain/photo-jobs.js';
import { FileStore } from './adapters/file-store.js';
import { PhotoRenderer } from './adapters/photo-renderer.js';
import { Vision } from './adapters/vision.js';
import { DemoAuth } from './adapters/auth.js';
import { demoCatalog } from './adapters/catalog.js';
import { createRouter } from './routes/router.js';
export async function createDigitalJiaozi(options={}) {
  const config=configuration(options.config);
  if(!config.demo && (!options.authenticate || !options.catalog || config.mediaSecret.length<32 || (!options.verifyInternal&&config.internalSecret.length<32))) throw new Error('正式模式需要注入 authenticate/catalog，并配置独立媒体密钥及内部事件鉴权');
  const repo=options.repository||new Repository(config.dataDir);
  if(config.demo&&!config.mediaSecret) {
    let row=repo.one("SELECT value FROM dj_metadata WHERE key='media-secret'");
    if(!row) {repo.run('INSERT INTO dj_metadata VALUES(?,?)','media-secret',randomBytes(32).toString('hex'));row=repo.one("SELECT value FROM dj_metadata WHERE key='media-secret'");}
    config.mediaSecret=row.value;
  }
  const files=options.fileStore||new FileStore(config),renderer=options.renderer||new PhotoRenderer(),vision=options.vision||new Vision(config);
  const commerce=new Commerce(repo,config,options.catalog||demoCatalog),auth=new DemoAuth(repo,config),jobs=new PhotoJobs(repo,config,commerce,files,renderer,vision);
  if(config.demo)commerce.seedRewards();
  const module={config,repo,files,renderer,vision,commerce,auth,jobs,authenticate:options.authenticate||(req=>auth.authenticate(req)),verifyInternal:options.verifyInternal};
  await jobs.recover();module.router=createRouter(module);
  return module;
}
