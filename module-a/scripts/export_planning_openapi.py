"""Export the actual planning API contract without starting external clients."""
import json
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'backend'))
from app.main import app

contract=app.openapi()
keep={'/health','/api/v1/demo/sessions','/api/v1/position','/api/v1/dynamic-state',
      '/api/v1/demo/events','/api/v1/places','/api/v1/places/{place_id}',
      '/api/v1/route-options','/api/v1/routes','/api/v1/routes/{route_id}',
      '/api/v1/routes/{route_id}/start','/api/v1/routes/{route_id}/progress',
      '/api/v1/routes/{route_id}/assessment','/api/v1/routes/{route_id}/replan',
      '/api/v1/routes/{route_id}/accept','/api/v1/chat','/api/v1/intents/resolve',
      '/api/v1/tools','/api/v1/tools/call','/api/v1/model-status'}
contract['paths']={path:value for path,value in contract['paths'].items() if path in keep}
contract['info']['description']='规划侧只返回真实位置与路线；地图和商家目录由合作团队提供。响应动态字段与分工说明见 接口文档.md。'
contract['servers']=[{'url':'http://127.0.0.1:8004','description':'本机开发入口，真机需改成可达服务地址'}]
output=ROOT/'docs/ROUTE_PLANNING_OPENAPI.json'
output.write_text(json.dumps(contract,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'output':str(output),'paths':len(contract['paths'])},ensure_ascii=False))
