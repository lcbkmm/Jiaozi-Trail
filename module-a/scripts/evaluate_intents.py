"""Live language accuracy evaluation; never substitutes fixtures for model output."""
import argparse,json,sys,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"backend"))
from app.config import Settings
from app.intent.gateway import ModelGateway
from app.errors import AppError
from app.schemas import Place,Preferences
from app.catalog import CatalogIndex
from app.schemas import CampaignStop


def contains(actual,expected):
    if isinstance(expected,dict):return isinstance(actual,dict) and all(contains(actual.get(k),v) for k,v in expected.items())
    if isinstance(expected,list):return isinstance(actual,list) and all(any(contains(item,want) for item in actual) for want in expected)
    return actual==expected


def matches_patch(actual,key,expected):
    if key=='visit_sequence':
        return isinstance(actual,list) and len(actual)==len(expected) and all(contains(a,e) for a,e in zip(actual,expected))
    return contains(actual,expected)


def main():
    parser=argparse.ArgumentParser();parser.add_argument("--limit",type=int,default=3);parser.add_argument("--case-ids",default="");parser.add_argument("--cases",type=Path,default=ROOT/"data/intent_eval_cases.json");parser.add_argument("--report",type=Path,default=ROOT/"runtime/intent_eval_live.json");args=parser.parse_args()
    if not 1<=args.limit<=36:parser.error("limit must be 1..36")
    settings=Settings.load();gateway=ModelGateway(settings)
    places=[Place.model_validate(row) for row in json.loads(settings.places_path.read_text(encoding='utf-8'))]
    stops=[CampaignStop.model_validate(row) for row in json.loads(settings.campaign_path.read_text(encoding='utf-8'))['stops']]
    index=CatalogIndex(places,stops)
    baseline=Preferences(start_place_id="chunxi_start",departure_at="2026-10-31T14:00:00+08:00",max_duration_s=10800,budget_per_person_fen=20000,interests=["coffee","food","landmark"]).model_dump(mode="json")
    cases=json.loads(args.cases.read_text(encoding="utf-8"))
    if args.case_ids:
        requested=set(args.case_ids.split(","));cases=[case for case in cases if case["id"] in requested]
        if not cases:parser.error("No matching case IDs")
    cases=cases[:args.limit]
    results=[];blocked=None
    try:
        for case in cases:
            start=time.monotonic()
            catalog=index.model_candidates(case['text'],index.places['chunxi_start'],['chunxi_start',case['selected_place_id']])
            vocabulary={**index.vocabulary,**case.get('vocabulary',{})}
            try:parsed=gateway.parse(case["text"],{**baseline,**case.get("preferences_patch",{})},catalog,[],case["selected_place_id"],vocabulary)
            except AppError as error:
                if error.code in {"MODEL_UNAVAILABLE","MODEL_NOT_CONFIGURED","UPSTREAM_TIMEOUT"}:
                    blocked={"code":error.code,"details":error.details};break
                results.append({"id":case["id"],"passed":False,"error":error.code});continue
            actual={op.type for op in parsed.operations}
            patch={k:v for op in parsed.operations if op.patch for k,v in op.patch.model_dump(exclude_none=True).items()}
            expected_patch=case["expected_patch"] or {}
            passed=(bool(parsed.clarification) if case["expect_clarification"] else
                not parsed.clarification and set(case["expected_operations"])<=actual and all(
                    matches_patch(patch.get(key),key,value)
                    for key,value in expected_patch.items()))
            for key,value in case.get("exact_patch",{}).items():
                if patch.get(key)!=value:passed=False
            if case.get("expected_duration_scope") and not any(op.duration_scope==case["expected_duration_scope"] for op in parsed.operations):passed=False
            if set(case.get("forbidden_required_experiences",[])) & set(patch.get("required_experiences",[])): passed=False
            results.append({"id":case["id"],"passed":passed,"operations":sorted(actual),"patch":patch,
                            "clarification":parsed.clarification,"metrics":gateway.last_parse_metrics,"elapsed_ms":round((time.monotonic()-start)*1000)})
    finally:gateway.close()
    report={"mode":"live_configured_model_only","model":settings.llm_model,"requested_cases":len(cases),
            "evaluated_cases":len(results),"passed_cases":sum(r["passed"] for r in results),
            "accuracy":sum(r["passed"] for r in results)/len(results) if results else None,
            "blocked":blocked,"results":results,"jev_comparison":"not_run"}
    args.report.parent.mkdir(parents=True,exist_ok=True)
    args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print(json.dumps(report,ensure_ascii=False,indent=2))
    return 0 if not blocked and all(r["passed"] for r in results) else 1


if __name__=="__main__":sys.exit(main())
