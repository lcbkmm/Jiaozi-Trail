"""Run only the configured model; never fall back or print credentials."""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"backend"))
from app.config import Settings
from app.intent.gateway import ModelGateway
from app.intent.binary_backend import yes_probability, JevAdvisor
from app.errors import AppError


def main():
    settings=Settings.load();gateway=ModelGateway(settings)
    report={"observed_at":datetime.now(timezone.utc).isoformat(),"model":settings.llm_model,
            "fallback_model_used":False,"checks":{}}
    try:
        data=gateway.complete({"messages":[{"role":"system","content":"Output only one lowercase token: yes or no. No explanation."},{"role":"user","content":"用户说记在交子上，是否想添加个人记忆？"}],
            "max_tokens":1,"temperature":0,"logprobs":True,"top_logprobs":5,**gateway.thinking()},bypass_circuit=True)
        try:
            yes_probability(data)
            report["checks"]["binary_logprobs"]={"ok":True}
        except AppError as error:
            report["checks"]["binary_logprobs"]={"ok":False,"code":error.code}
        parsed=gateway.parse("预算改为150元",{"budget_per_person_fen":20000},[],[],None)
        report["checks"]["structured_extraction"]={"ok":True,"operations":[op.model_dump(exclude_none=True) for op in parsed.operations]}
        try:
            from dataclasses import replace
            original=gateway.settings
            gateway.settings=replace(original,jev_enabled=True)
            report["checks"]["jev_library"]={"ok":True,"result":JevAdvisor(gateway).advise("这家很好吃，帮我记在交子上","hotpot",["add_memory","insert_place"])}
        except AppError as error:
            report["checks"]["jev_library"]={"ok":False,"code":error.code}
        finally:gateway.settings=original
    except AppError as error:
        report["checks"]["configured_model"]={"ok":False,"code":error.code,"details":error.details}
    finally:
        gateway.close()
    report["all_passed"]=bool(report["checks"]) and all(row["ok"] for row in report["checks"].values())
    (ROOT/"runtime").mkdir(exist_ok=True)
    (ROOT/"runtime/model_probe.json").write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(report,ensure_ascii=False,indent=2))
    return 0 if report["all_passed"] else 1


if __name__=="__main__":sys.exit(main())
