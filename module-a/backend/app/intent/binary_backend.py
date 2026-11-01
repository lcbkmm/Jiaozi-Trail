from __future__ import annotations
import math
from llm2jev import Choice, JevRequest, LLM2Jev, ScoreOutput, Usage
from app.errors import AppError


def yes_probability(data):
    try:
        rows = data["choices"][0]["logprobs"]["content"][0]["top_logprobs"]
        if not isinstance(rows, list) or len(rows)>5:
            raise ValueError("Unsupported top-k")
        scores = {}
        for row in rows:
            token = str(row["token"]).strip().lower()
            value = float(row["logprob"])
            if not math.isfinite(value) or value > 0:
                raise ValueError("Invalid logprob")
            if token in {"yes", "no"}:
                # Aggregate probability mass of declared whitespace/case variants.
                scores[token] = scores.get(token, 0.0)+math.exp(value)
        if not scores.get("yes") or not scores.get("no"):
            raise ValueError("Both candidates must be present")
        return scores["yes"]/(scores["yes"]+scores["no"])
    except (KeyError, TypeError, IndexError, ValueError, OverflowError):
        raise AppError("JEV_SCORES_UNAVAILABLE", "单 token 响应缺少完整有效的 yes/no 分数，需用户确认。", 503) from None


class RemoteBinaryBackend:
    def __init__(self, gateway):
        self.gateway = gateway
        self.last_raw_scores = []

    def score(self, *, model, prompts):
        if model != self.gateway.settings.llm_model or not 1 <= len(prompts) <= 3:
            raise ValueError("Only the configured model and up to three candidates are supported")
        self.last_raw_scores = []
        for prompt in prompts:
            data = self.gateway.complete({"messages":list(prompt),"max_tokens":1,"temperature":0,
                "logprobs":True,"top_logprobs":5, **self.gateway.thinking()})
            self.last_raw_scores.append(yes_probability(data))
            self.gateway.binary_verified = True
        return ScoreOutput(yes_probabilities=self.last_raw_scores, usage=Usage())


class JevAdvisor:
    LABELS = {"add_memory":"把选中的店作为个人记忆添加到交子", "insert_place":"把选中的店加入接下来行程", "get_place_details":"查看选中店铺的信息"}

    def __init__(self, gateway):
        self.gateway = gateway

    def advise(self, text, selected_place_id, candidates):
        if not self.gateway.settings.jev_enabled:
            return {"mode":"not_enabled", "requires_confirmation":True}
        if not 2 <= len(set(candidates)) <= 3:
            return {"mode":"not_applicable", "requires_confirmation":True}
        backend = RemoteBinaryBackend(self.gateway)
        evaluator = LLM2Jev(backend=backend)
        choice = Choice(instructions="根据用户本轮原话及已选店铺判断，候选只作辅助。", criteria={k:self.LABELS[k] for k in dict.fromkeys(candidates)})
        answer = evaluator.evaluate(JevRequest(model=self.gateway.settings.llm_model,
            state={"text":text,"selected_place_id":selected_place_id},questions={"intent":choice})).answers["intent"]
        return {"mode":"jev_logprobs", "suggested_operation":answer.choice,
                "raw_support":dict(zip(dict.fromkeys(candidates), backend.last_raw_scores)),
                "relative_probabilities":dict(answer.probabilities),
                "score_quality":"complete_candidates", "requires_confirmation":True,
                "notice":"相对候选支持度，不是校准正确率；不自动执行歧义操作。"}
