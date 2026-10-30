"""A small client for the Hyperresearch Answers REST API.

    POST /v1/answers          ask: one short answer checked against quoted sources, or an honest not_found
    POST /v1/answers/search   search: ranked sources with word-for-word passages, no synthesis
    GET  /v1/answers/{id}     a stored call (used to collect an ask that came back 202 pending)

Auth is ``Authorization: Bearer <hr_live_... key>`` with the ``answers:ask`` scope.
Every call is billed from the account's prepaid Answers balance.
"""

from __future__ import annotations

import asyncio
import os
import time
import uuid
from typing import Any, Literal, Optional

import httpx

DEFAULT_BASE_URL = "https://api.hyperresearch.ai"
API_KEY_ENV = "HYPERRESEARCH_API_KEY"
BASE_URL_ENV = "HYPERRESEARCH_BASE_URL"
__version__ = "0.1.0"

AskMode = Literal["fast", "standard", "max"]
SearchMode = Literal["standard", "max"]

POLL_WAIT_SECONDS = 45
MAX_RETRY_DELAY_S = 30.0


class HyperresearchError(Exception):
    """A non-2xx response, carrying the API's error envelope."""

    def __init__(
        self,
        status: int,
        message: str,
        *,
        type: Optional[str] = None,
        code: Optional[str] = None,
        param: Optional[str] = None,
        request_id: Optional[str] = None,
        retry_after: Optional[float] = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.type = type
        self.code = code
        self.param = param
        self.request_id = request_id
        self.retry_after = retry_after
        self.body = body

    def __repr__(self) -> str:
        return f"HyperresearchError(status={self.status}, code={self.code!r}, message={self.message!r})"


def _parse(response: httpx.Response) -> dict[str, Any]:
    try:
        data = response.json() if response.content else {}
    except ValueError:
        data = {"raw": response.text}
    return data if isinstance(data, dict) else {"data": data}


def _err(body: dict[str, Any]) -> dict[str, Any]:
    e = body.get("error")
    return e if isinstance(e, dict) else {}


def _retry_after(response: httpx.Response, body: dict[str, Any]) -> Optional[float]:
    err = _err(body)
    if isinstance(err.get("retry_after"), (int, float)):
        return float(err["retry_after"])
    try:
        return float(response.headers.get("Retry-After", ""))
    except ValueError:
        return None


def _error(response: httpx.Response, body: dict[str, Any]) -> HyperresearchError:
    err = _err(body)
    return HyperresearchError(
        response.status_code,
        err.get("message") or f"Hyperresearch API error {response.status_code}",
        type=err.get("type"),
        code=err.get("code"),
        param=err.get("param"),
        request_id=err.get("request_id"),
        retry_after=_retry_after(response, body),
        body=body,
    )


class HyperresearchClient:
    """Sync and async access to the Answers API.

    Args:
        api_key: Defaults to the ``HYPERRESEARCH_API_KEY`` environment variable.
        base_url: Defaults to ``HYPERRESEARCH_BASE_URL``, then https://api.hyperresearch.ai.
        ask_timeout: Seconds an ask may take end to end, including polling. Default 360 (max mode runs up to about 5 minutes).
        search_timeout: Seconds a search may take. Default 90.
        max_retries: Retries on 429/503 (capacity), honouring Retry-After. Default 2.
        transport / async_transport: httpx transports (tests, proxies).
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        *,
        ask_timeout: float = 360.0,
        search_timeout: float = 90.0,
        max_retries: int = 2,
        headers: Optional[dict[str, str]] = None,
        transport: Optional[httpx.BaseTransport] = None,
        async_transport: Optional[httpx.AsyncBaseTransport] = None,
    ) -> None:
        self.api_key = api_key or os.environ.get(API_KEY_ENV)
        self.base_url = (base_url or os.environ.get(BASE_URL_ENV) or DEFAULT_BASE_URL).rstrip("/")
        self.ask_timeout = ask_timeout
        self.search_timeout = search_timeout
        self.max_retries = max_retries
        self.extra_headers = dict(headers or {})
        self._transport = transport
        self._async_transport = async_transport
        # Test seams.
        self._sleep = time.sleep
        self._asleep = asyncio.sleep

    # ---- shared ----

    def _headers(self, extra: Optional[dict[str, str]] = None) -> dict[str, str]:
        if not self.api_key:
            raise HyperresearchError(
                401,
                f"No Hyperresearch API key. Set {API_KEY_ENV} or pass api_key. "
                "Create one with the answers:ask scope at https://console.hyperresearch.ai/#/keys",
                code="missing_api_key",
            )
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": "application/json",
            "User-Agent": f"langchain-hyperresearch/{__version__}",
            **self.extra_headers,
            **(extra or {}),
        }

    @staticmethod
    def _ask_body(question: str, mode: str, as_of: Optional[str], max_cost_cents: Optional[float]) -> dict[str, Any]:
        body: dict[str, Any] = {"question": question, "mode": mode}
        if as_of is not None:
            body["as_of"] = as_of
        if max_cost_cents is not None:
            body["max_cost_cents"] = max_cost_cents
        return body

    def _delay(self, attempt: int, retry_after: Optional[float]) -> float:
        return min(retry_after if retry_after is not None else 2.0**attempt, MAX_RETRY_DELAY_S)

    # ---- sync ----

    def _request(
        self, client: httpx.Client, method: str, path: str, *, json: Any = None, headers: Optional[dict[str, str]] = None
    ) -> tuple[int, dict[str, Any]]:
        attempt = 0
        while True:
            response = client.request(method, f"{self.base_url}{path}", json=json, headers=self._headers(headers))
            body = _parse(response)
            if response.is_success:
                return response.status_code, body
            if response.status_code in (429, 503) and attempt < self.max_retries:
                self._sleep(self._delay(attempt, _retry_after(response, body)))
                attempt += 1
                continue
            raise _error(response, body)

    def ask(self, question: str, mode: AskMode = "standard", *, as_of: Optional[str] = None, max_cost_cents: Optional[float] = None) -> dict[str, Any]:
        """Ask one question. A 202 ``pending`` is collected from GET /v1/answers/{id} (charged once)."""
        deadline = time.monotonic() + self.ask_timeout
        with httpx.Client(transport=self._transport, timeout=httpx.Timeout(self.ask_timeout)) as client:
            status, body = self._request(
                client,
                "POST",
                "/v1/answers",
                json=self._ask_body(question, mode, as_of, max_cost_cents),
                headers={"Idempotency-Key": str(uuid.uuid4()), "Prefer": f"respond-async; wait={POLL_WAIT_SECONDS + 5}"},
            )
            while status == 202 or body.get("status") == "pending":
                call_id = body.get("id")
                if not call_id:
                    raise HyperresearchError(status, "The API answered pending without a call id.", body=body)
                if time.monotonic() > deadline:
                    raise HyperresearchError(
                        408, f"Ask {call_id} did not finish within {self.ask_timeout:.0f}s; fetch it later with get_call().", code="client_timeout", body=body
                    )
                status, body = self._request(client, "GET", f"/v1/answers/{call_id}?wait={POLL_WAIT_SECONDS}")
            return body

    def search(self, query: str, max_results: int = 10, mode: SearchMode = "standard") -> dict[str, Any]:
        """Ranked raw sources with verbatim passages."""
        with httpx.Client(transport=self._transport, timeout=httpx.Timeout(self.search_timeout)) as client:
            _, body = self._request(
                client,
                "POST",
                "/v1/answers/search",
                json={"query": query, "max_results": max_results, "mode": mode},
                headers={"Idempotency-Key": str(uuid.uuid4())},
            )
            return body

    def get_call(self, call_id: str, wait: Optional[int] = None) -> dict[str, Any]:
        """A stored call. Free."""
        path = f"/v1/answers/{call_id}" + (f"?wait={wait}" if wait is not None else "")
        with httpx.Client(transport=self._transport, timeout=httpx.Timeout(60.0)) as client:
            _, body = self._request(client, "GET", path)
            return body

    # ---- async ----

    async def _arequest(
        self, client: httpx.AsyncClient, method: str, path: str, *, json: Any = None, headers: Optional[dict[str, str]] = None
    ) -> tuple[int, dict[str, Any]]:
        attempt = 0
        while True:
            response = await client.request(method, f"{self.base_url}{path}", json=json, headers=self._headers(headers))
            body = _parse(response)
            if response.is_success:
                return response.status_code, body
            if response.status_code in (429, 503) and attempt < self.max_retries:
                await self._asleep(self._delay(attempt, _retry_after(response, body)))
                attempt += 1
                continue
            raise _error(response, body)

    async def aask(self, question: str, mode: AskMode = "standard", *, as_of: Optional[str] = None, max_cost_cents: Optional[float] = None) -> dict[str, Any]:
        deadline = time.monotonic() + self.ask_timeout
        async with httpx.AsyncClient(transport=self._async_transport, timeout=httpx.Timeout(self.ask_timeout)) as client:
            status, body = await self._arequest(
                client,
                "POST",
                "/v1/answers",
                json=self._ask_body(question, mode, as_of, max_cost_cents),
                headers={"Idempotency-Key": str(uuid.uuid4()), "Prefer": f"respond-async; wait={POLL_WAIT_SECONDS + 5}"},
            )
            while status == 202 or body.get("status") == "pending":
                call_id = body.get("id")
                if not call_id:
                    raise HyperresearchError(status, "The API answered pending without a call id.", body=body)
                if time.monotonic() > deadline:
                    raise HyperresearchError(
                        408, f"Ask {call_id} did not finish within {self.ask_timeout:.0f}s; fetch it later with get_call().", code="client_timeout", body=body
                    )
                status, body = await self._arequest(client, "GET", f"/v1/answers/{call_id}?wait={POLL_WAIT_SECONDS}")
            return body

    async def asearch(self, query: str, max_results: int = 10, mode: SearchMode = "standard") -> dict[str, Any]:
        async with httpx.AsyncClient(transport=self._async_transport, timeout=httpx.Timeout(self.search_timeout)) as client:
            _, body = await self._arequest(
                client,
                "POST",
                "/v1/answers/search",
                json={"query": query, "max_results": max_results, "mode": mode},
                headers={"Idempotency-Key": str(uuid.uuid4())},
            )
            return body


def compact_answer(r: dict[str, Any]) -> dict[str, Any]:
    """The form a model reads: the answer, its quotes, and what it cost."""
    out: dict[str, Any] = {
        "id": r.get("id"),
        "status": r.get("status"),
        "answer": r.get("answer", ""),
        "evidence": [
            {k: e.get(k) for k in ("url", "title", "quote", "check") if e.get(k) is not None} for e in (r.get("evidence") or []) if isinstance(e, dict)
        ],
    }
    if r.get("caveat"):
        out["caveat"] = r["caveat"]
    if r.get("escalated"):
        out["escalated"] = True
    if r.get("error"):
        out["error"] = r["error"]
    out["price_cents"] = r.get("price_cents")
    return out


def compact_search(r: dict[str, Any]) -> dict[str, Any]:
    results = []
    for x in r.get("results") or []:
        if not isinstance(x, dict):
            continue
        row = {k: x.get(k) for k in ("rank", "url", "title", "published", "source") if x.get(k) is not None}
        row["passages"] = [{"text": p.get("text"), "verified": p.get("verified")} for p in (x.get("passages") or []) if isinstance(p, dict)]
        results.append(row)
    return {"id": r.get("id"), "status": r.get("status"), "query": r.get("query"), "results": results, "price_cents": r.get("price_cents")}
