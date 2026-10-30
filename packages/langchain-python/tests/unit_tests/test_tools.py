"""Unit tests with mocked HTTP. No network, no API key."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from langchain_core.messages import ToolMessage
from pydantic import ValidationError

from langchain_hyperresearch import (
    HyperresearchAnswerTool,
    HyperresearchClient,
    HyperresearchError,
    HyperresearchRetriever,
    HyperresearchSearchTool,
)

QUOTE = "No Person shall be a Senator who shall not have attained to the Age of thirty Years"
URL1 = "https://www.archives.gov/founding-docs/constitution-transcript"

ANSWERED: dict[str, Any] = {
    "id": "ans_01",
    "call_id": "ans_01",
    "status": "answered",
    "answer": "At least 30 years old (US Constitution, Article I, Section 3).",
    "evidence": [{"url": URL1, "title": "The Constitution", "quote": QUOTE, "check": "verified", "page_verified": True}],
    "escalated": False,
    "mode": "fast",
    "price_cents": 5,
    "balance_cents": 495,
}

SEARCHED: dict[str, Any] = {
    "id": "ans_02",
    "query": "minimum age to serve as a US senator",
    "results": [
        {"rank": 1, "url": URL1, "title": "The Constitution", "source": "web", "kind": "web", "passages": [{"text": QUOTE, "verified": True}]},
        {
            "rank": 2,
            "url": "https://constitution.congress.gov/browse/article-1/section-3/",
            "title": "Art. I, S3",
            "source": "web",
            "snippet": "Senate",
            "passages": [],
        },
    ],
    "meta": {"ms": 800},
    "status": "ok",
    "mode": "standard",
    "price_cents": 5,
    "balance_cents": 490,
}


class Recorder:
    """Scripted responses for httpx.MockTransport, recording every request."""

    def __init__(self, responses: list[tuple[int, Any, dict[str, str]]]) -> None:
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self.responses:
            raise AssertionError(f"unexpected request {request.method} {request.url}")
        status, body, headers = self.responses.pop(0)
        return httpx.Response(status, json=body, headers=headers)

    def body(self, i: int) -> Any:
        return json.loads(self.requests[i].content) if self.requests[i].content else None


def make_client(*responses: tuple[int, Any] | tuple[int, Any, dict[str, str]]) -> tuple[HyperresearchClient, Recorder]:
    rec = Recorder([(r[0], r[1], r[2] if len(r) > 2 else {}) for r in responses])  # type: ignore[misc]
    client = HyperresearchClient(
        api_key="hr_live_test",
        transport=httpx.MockTransport(rec.handler),
        async_transport=httpx.MockTransport(rec.handler),
    )
    client._sleep = lambda s: None
    return client, rec


def test_answer_tool_posts_and_returns_compact_json() -> None:
    client, rec = make_client((200, ANSWERED))
    tool = HyperresearchAnswerTool(client=client)
    out = tool.invoke({"question": "How old must a US senator be?", "mode": "fast"})
    req = rec.requests[0]
    assert req.method == "POST"
    assert str(req.url) == "https://api.hyperresearch.ai/v1/answers"
    assert req.headers["Authorization"] == "Bearer hr_live_test"
    assert req.headers["Prefer"].startswith("respond-async; wait=")
    assert len(req.headers["Idempotency-Key"]) >= 8
    assert rec.body(0) == {"question": "How old must a US senator be?", "mode": "fast"}
    assert json.loads(out) == {
        "id": "ans_01",
        "status": "answered",
        "answer": ANSWERED["answer"],
        "evidence": [{"url": URL1, "title": "The Constitution", "quote": QUOTE, "check": "verified"}],
        "price_cents": 5,
    }


def test_answer_tool_call_returns_tool_message_with_artifact() -> None:
    client, _ = make_client((200, ANSWERED))
    tool = HyperresearchAnswerTool(client=client)
    msg = tool.invoke({"args": {"question": "q"}, "id": "call_1", "name": tool.name, "type": "tool_call"})
    assert isinstance(msg, ToolMessage)
    assert msg.tool_call_id == "call_1"
    assert json.loads(msg.content)["status"] == "answered"  # type: ignore[arg-type]
    assert msg.artifact["balance_cents"] == 495


def test_fixed_mode_cost_cap_and_as_of() -> None:
    client, rec = make_client((200, ANSWERED), (200, ANSWERED))
    HyperresearchAnswerTool(client=client).invoke({"question": "q"})
    HyperresearchAnswerTool(client=client, mode="max", max_cost_cents=50).invoke({"question": "q", "mode": "fast", "as_of": "2026-01-01"})
    assert rec.body(0) == {"question": "q", "mode": "standard"}
    assert rec.body(1) == {"question": "q", "mode": "max", "as_of": "2026-01-01", "max_cost_cents": 50}


def test_pending_ask_is_collected_by_polling() -> None:
    pending = {"id": "ans_03", "status": "pending", "poll_after_seconds": 15, "price_cents_max": 20}
    client, rec = make_client((202, pending), (202, pending), (200, {**ANSWERED, "id": "ans_03", "escalated": True, "price_cents": 20}))
    out = json.loads(HyperresearchAnswerTool(client=client).invoke({"question": "hard"}))
    assert [f"{r.method} {r.url}" for r in rec.requests] == [
        "POST https://api.hyperresearch.ai/v1/answers",
        "GET https://api.hyperresearch.ai/v1/answers/ans_03?wait=45",
        "GET https://api.hyperresearch.ai/v1/answers/ans_03?wait=45",
    ]
    assert out["escalated"] is True and out["price_cents"] == 20


def test_not_found_and_engine_error_are_results() -> None:
    client, _ = make_client(
        (200, {"id": "a", "status": "not_found", "answer": "No source we could read states this figure.", "evidence": [], "price_cents": 2}),
        (200, {"id": "b", "status": "error", "answer": "", "evidence": [], "price_cents": 0, "error": {"code": "engine_unavailable", "message": "try again"}}),
    )
    tool = HyperresearchAnswerTool(client=client)
    assert json.loads(tool.invoke({"question": "a"}))["status"] == "not_found"
    err = json.loads(tool.invoke({"question": "b"}))
    assert err["status"] == "error" and err["error"]["code"] == "engine_unavailable"


def test_invalid_input_is_rejected_before_any_request() -> None:
    client, rec = make_client()
    with pytest.raises(ValidationError):
        HyperresearchAnswerTool(client=client).invoke({"question": ""})
    with pytest.raises(ValidationError):
        HyperresearchSearchTool(client=client).invoke({"query": "x", "max_results": 26})
    assert rec.requests == []


def test_search_tool() -> None:
    client, rec = make_client((200, SEARCHED))
    out = json.loads(HyperresearchSearchTool(client=client, max_results=5).invoke({"query": SEARCHED["query"], "mode": "max"}))
    assert str(rec.requests[0].url) == "https://api.hyperresearch.ai/v1/answers/search"
    assert "Prefer" not in rec.requests[0].headers
    assert rec.body(0) == {"query": SEARCHED["query"], "max_results": 5, "mode": "max"}
    assert out["results"][0] == {"rank": 1, "url": URL1, "title": "The Constitution", "source": "web", "passages": [{"text": QUOTE, "verified": True}]}
    assert out["price_cents"] == 5


def test_api_error_envelope_raises() -> None:
    client, _ = make_client((402, {"error": {"type": "quota_exceeded", "code": "insufficient_balance", "message": "Top up.", "request_id": "req_1"}}))
    with pytest.raises(HyperresearchError) as exc:
        HyperresearchAnswerTool(client=client).invoke({"question": "q"})
    assert exc.value.status == 402
    assert exc.value.code == "insufficient_balance"
    assert exc.value.request_id == "req_1"


def test_capacity_503_is_retried_with_same_idempotency_key() -> None:
    client, rec = make_client(
        (
            503,
            {"error": {"type": "provider_unavailable", "code": "answers_capacity", "message": "busy", "retry_after": 3, "request_id": "r"}},
            {"Retry-After": "3"},
        ),
        (200, SEARCHED),
    )
    waits: list[float] = []
    client._sleep = waits.append
    assert client.search("x")["status"] == "ok"
    assert waits == [3.0]
    assert rec.requests[0].headers["Idempotency-Key"] == rec.requests[1].headers["Idempotency-Key"]


def test_missing_key_refuses_without_network(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HYPERRESEARCH_API_KEY", raising=False)
    rec = Recorder([])
    client = HyperresearchClient(transport=httpx.MockTransport(rec.handler))
    with pytest.raises(HyperresearchError) as exc:
        client.search("x")
    assert exc.value.code == "missing_api_key"
    assert rec.requests == []


def test_env_key_and_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HYPERRESEARCH_API_KEY", "hr_live_env")
    monkeypatch.setenv("HYPERRESEARCH_BASE_URL", "https://staging.example.test/")
    rec = Recorder([(200, SEARCHED, {})])
    HyperresearchClient(transport=httpx.MockTransport(rec.handler)).search("x")
    assert str(rec.requests[0].url) == "https://staging.example.test/v1/answers/search"
    assert rec.requests[0].headers["Authorization"] == "Bearer hr_live_env"


def test_api_key_param_builds_client(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HYPERRESEARCH_API_KEY", raising=False)
    tool = HyperresearchAnswerTool(api_key="hr_live_param")  # type: ignore[arg-type]
    assert tool.client is not None and tool.client.api_key == "hr_live_param"
    assert "hr_live_param" not in repr(tool)


def test_retriever_maps_documents() -> None:
    client, rec = make_client((200, SEARCHED))
    docs = HyperresearchRetriever(client=client, max_results=2).invoke(SEARCHED["query"])
    assert rec.body(0) == {"query": SEARCHED["query"], "max_results": 2, "mode": "standard"}
    assert len(docs) == 2
    assert docs[0].page_content == QUOTE
    assert docs[0].metadata["url"] == URL1 and docs[0].metadata["verified"] is True and docs[0].metadata["call_id"] == "ans_02"
    assert docs[1].page_content == "Senate"


async def test_async_tools_and_retriever() -> None:
    client, rec = make_client(
        (202, {"id": "ans_09", "status": "pending"}),
        (200, {**ANSWERED, "id": "ans_09"}),
        (200, SEARCHED),
        (200, SEARCHED),
    )
    out = json.loads(await HyperresearchAnswerTool(client=client).ainvoke({"question": "q"}))
    assert out["id"] == "ans_09"
    s = json.loads(await HyperresearchSearchTool(client=client).ainvoke({"query": "x"}))
    assert s["status"] == "ok"
    docs = await HyperresearchRetriever(client=client).ainvoke("x")
    assert docs[0].metadata["rank"] == 1
    assert str(rec.requests[1].url).endswith("/v1/answers/ans_09?wait=45")
