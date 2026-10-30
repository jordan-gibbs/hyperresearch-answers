"""Hyperresearch Answers tools for LangChain."""

from __future__ import annotations

import json
from typing import Any, Literal, Optional

from langchain_core.callbacks import AsyncCallbackManagerForToolRun, CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator

from langchain_hyperresearch._client import (
    AskMode,
    HyperresearchClient,
    SearchMode,
    compact_answer,
    compact_search,
)

ANSWER_DESCRIPTION = (
    "Answer one factual question with Hyperresearch Answers. Researches the open web and about 45 structured sources "
    "(filings, statistics, registers, scholarly indexes, books) on the server and returns one short answer with the quotes it rests on, "
    "each checked word for word against its page, or status not_found when nothing supports an answer. "
    "Prefer this over a loop of searches for any factual lookup. Modes: fast (5¢), standard (10¢, 20¢ if it digs deeper; default), "
    "max (50¢, numbers confirmed on two sites). Each call is charged to the user's prepaid Hyperresearch Answers balance."
)

SEARCH_DESCRIPTION = (
    "Search the web and Hyperresearch's ~45 structured sources (filings, statistics, registers, scholarly, books). "
    "Returns ranked raw sources with verbatim passages. No synthesis. Use when you need to read the sources yourself. "
    "Modes: standard (5¢, default), max (15¢: every provider plus structured data rows and PDF tables, for hard lookups). "
    "Each call is charged to the user's prepaid Hyperresearch Answers balance."
)


class HyperresearchAnswerInput(BaseModel):
    """Input for HyperresearchAnswerTool."""

    question: str = Field(min_length=1, max_length=2000, description="One factual question, asked the way you would ask a researcher.")
    mode: Optional[Literal["fast", "standard", "max"]] = Field(
        default=None,
        description="How hard to look: fast (5¢, about 45 s), standard (10¢, 20¢ if it digs deeper; default, up to about 3 min) "
        "or max (50¢, up to about 5 min).",
    )
    as_of: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$", description="Answer as of this date (YYYY-MM-DD). Omit for today.")


class HyperresearchSearchInput(BaseModel):
    """Input for HyperresearchSearchTool."""

    query: str = Field(min_length=1, max_length=1000, description="What to find, as a question or a precise phrase.")
    max_results: Optional[int] = Field(
        default=None, ge=1, le=25, description="How many ranked sources to return (1-25, default 10). The price does not change."
    )
    mode: Optional[Literal["standard", "max"]] = Field(
        default=None,
        description="standard (5¢, default) or max (15¢: every provider, plus structured data rows and PDF tables, for hard lookups).",
    )


class _HyperresearchBase(BaseTool):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    api_key: Optional[SecretStr] = Field(default=None, exclude=True)
    """Defaults to the HYPERRESEARCH_API_KEY environment variable."""
    base_url: Optional[str] = None
    """Defaults to HYPERRESEARCH_BASE_URL, then https://api.hyperresearch.ai."""
    client: Optional[HyperresearchClient] = Field(default=None, exclude=True)
    """Share one client between tools and retrievers."""

    response_format: Literal["content_and_artifact"] = "content_and_artifact"

    @model_validator(mode="after")
    def _build_client(self) -> _HyperresearchBase:
        if self.client is None:
            self.client = HyperresearchClient(
                api_key=self.api_key.get_secret_value() if self.api_key else None,
                base_url=self.base_url,
            )
        return self


class HyperresearchAnswerTool(_HyperresearchBase):
    """Hyperresearch Answers ``ask``: one checked answer with its quotes, or ``not_found``.

    Setup:
        .. code-block:: bash

            pip install -U langchain-hyperresearch
            export HYPERRESEARCH_API_KEY="hr_live_..."

    Instantiate:
        .. code-block:: python

            from langchain_hyperresearch import HyperresearchAnswerTool

            tool = HyperresearchAnswerTool()  # the model picks the mode
            tool = HyperresearchAnswerTool(mode="fast", max_cost_cents=5)

    Invoke directly:
        .. code-block:: python

            tool.invoke({"question": "How old must a US senator be?", "mode": "fast"})

    Invoke with a ToolCall (returns a ToolMessage; ``artifact`` is the full API response):
        .. code-block:: python

            tool.invoke({"args": {"question": "How old must a US senator be?"}, "id": "1", "name": tool.name, "type": "tool_call"})
    """

    name: str = "hyperresearch_answer"
    description: str = ANSWER_DESCRIPTION
    args_schema: type[BaseModel] = HyperresearchAnswerInput

    mode: Optional[AskMode] = None
    """Fix the mode; the model then cannot choose it."""
    max_cost_cents: Optional[float] = None
    """Cap every call, in cents. A standard ask under 20 never escalates."""

    def _mode(self, mode: Optional[str]) -> str:
        return self.mode or mode or "standard"

    def _run(
        self,
        question: str,
        mode: Optional[str] = None,
        as_of: Optional[str] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> tuple[str, dict[str, Any]]:
        assert self.client is not None
        raw = self.client.ask(question, self._mode(mode), as_of=as_of, max_cost_cents=self.max_cost_cents)  # type: ignore[arg-type]
        return json.dumps(compact_answer(raw), ensure_ascii=False), raw

    async def _arun(
        self,
        question: str,
        mode: Optional[str] = None,
        as_of: Optional[str] = None,
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
    ) -> tuple[str, dict[str, Any]]:
        assert self.client is not None
        raw = await self.client.aask(question, self._mode(mode), as_of=as_of, max_cost_cents=self.max_cost_cents)  # type: ignore[arg-type]
        return json.dumps(compact_answer(raw), ensure_ascii=False), raw


class HyperresearchSearchTool(_HyperresearchBase):
    """Hyperresearch Answers ``search``: ranked raw sources with verbatim passages.

    Setup:
        .. code-block:: bash

            pip install -U langchain-hyperresearch
            export HYPERRESEARCH_API_KEY="hr_live_..."

    Instantiate:
        .. code-block:: python

            from langchain_hyperresearch import HyperresearchSearchTool

            tool = HyperresearchSearchTool(max_results=5)

    Invoke:
        .. code-block:: python

            tool.invoke({"query": "minimum age to serve as a US senator"})
    """

    name: str = "hyperresearch_search"
    description: str = SEARCH_DESCRIPTION
    args_schema: type[BaseModel] = HyperresearchSearchInput

    mode: Optional[SearchMode] = None
    """Fix the mode; the model then cannot choose it."""
    max_results: Optional[int] = Field(default=None, ge=1, le=25)
    """Fix the number of results (1-25)."""

    def _args(self, max_results: Optional[int], mode: Optional[str]) -> tuple[int, str]:
        return self.max_results or max_results or 10, self.mode or mode or "standard"

    def _run(
        self,
        query: str,
        max_results: Optional[int] = None,
        mode: Optional[str] = None,
        run_manager: Optional[CallbackManagerForToolRun] = None,
    ) -> tuple[str, dict[str, Any]]:
        assert self.client is not None
        n, m = self._args(max_results, mode)
        raw = self.client.search(query, n, m)  # type: ignore[arg-type]
        return json.dumps(compact_search(raw), ensure_ascii=False), raw

    async def _arun(
        self,
        query: str,
        max_results: Optional[int] = None,
        mode: Optional[str] = None,
        run_manager: Optional[AsyncCallbackManagerForToolRun] = None,
    ) -> tuple[str, dict[str, Any]]:
        assert self.client is not None
        n, m = self._args(max_results, mode)
        raw = await self.client.asearch(query, n, m)  # type: ignore[arg-type]
        return json.dumps(compact_search(raw), ensure_ascii=False), raw
