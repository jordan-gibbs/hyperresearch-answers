"""A LangChain retriever over Hyperresearch Answers ``search``."""

from __future__ import annotations

from typing import Any, Optional

from langchain_core.callbacks import AsyncCallbackManagerForRetrieverRun, CallbackManagerForRetrieverRun
from langchain_core.documents import Document
from langchain_core.retrievers import BaseRetriever
from pydantic import ConfigDict, Field, SecretStr, model_validator

from langchain_hyperresearch._client import HyperresearchClient, SearchMode


def _to_documents(res: dict[str, Any]) -> list[Document]:
    docs = []
    for r in res.get("results") or []:
        if not isinstance(r, dict):
            continue
        passages = [p for p in (r.get("passages") or []) if isinstance(p, dict)]
        texts = [p["text"] for p in passages if p.get("text")]
        docs.append(
            Document(
                page_content="\n\n".join(texts) if texts else (r.get("snippet") or ""),
                metadata={
                    "url": r.get("url"),
                    "title": r.get("title"),
                    "rank": r.get("rank"),
                    "source": r.get("source"),
                    "published": r.get("published"),
                    "verified": all(p.get("verified") is not False for p in passages),
                    "call_id": res.get("id"),
                },
            )
        )
    return docs


class HyperresearchRetriever(BaseRetriever):
    """Ranked sources from Hyperresearch Answers ``search``, one Document per source.

    ``page_content`` is the matched passages, verbatim (or the snippet when there are none).
    ``metadata`` carries url, title, rank, source, published, verified and the call id.
    Each retrieval is one billed ``search`` call (standard 5¢, max 15¢).

    Example:
        .. code-block:: python

            from langchain_hyperresearch import HyperresearchRetriever

            retriever = HyperresearchRetriever(max_results=5)
            docs = retriever.invoke("minimum age to serve as a US senator")
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    max_results: int = Field(default=10, ge=1, le=25)
    mode: SearchMode = "standard"
    api_key: Optional[SecretStr] = Field(default=None, exclude=True)
    base_url: Optional[str] = None
    client: Optional[HyperresearchClient] = Field(default=None, exclude=True)

    @model_validator(mode="after")
    def _build_client(self) -> HyperresearchRetriever:
        if self.client is None:
            self.client = HyperresearchClient(
                api_key=self.api_key.get_secret_value() if self.api_key else None,
                base_url=self.base_url,
            )
        return self

    def _get_relevant_documents(self, query: str, *, run_manager: CallbackManagerForRetrieverRun) -> list[Document]:
        assert self.client is not None
        return _to_documents(self.client.search(query, self.max_results, self.mode))

    async def _aget_relevant_documents(self, query: str, *, run_manager: AsyncCallbackManagerForRetrieverRun) -> list[Document]:
        assert self.client is not None
        return _to_documents(await self.client.asearch(query, self.max_results, self.mode))
