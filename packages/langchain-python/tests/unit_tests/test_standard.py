"""LangChain standard unit tests (langchain-tests)."""

from __future__ import annotations

from langchain_tests.unit_tests import ToolsUnitTests

from langchain_hyperresearch import HyperresearchAnswerTool, HyperresearchSearchTool


class TestHyperresearchAnswerToolStandard(ToolsUnitTests):
    @property
    def tool_constructor(self) -> type[HyperresearchAnswerTool]:
        return HyperresearchAnswerTool

    @property
    def tool_constructor_params(self) -> dict:
        return {"api_key": "hr_live_fake"}

    @property
    def tool_invoke_params_example(self) -> dict:
        return {"question": "How old must a US senator be?", "mode": "fast"}


class TestHyperresearchSearchToolStandard(ToolsUnitTests):
    @property
    def tool_constructor(self) -> type[HyperresearchSearchTool]:
        return HyperresearchSearchTool

    @property
    def tool_constructor_params(self) -> dict:
        return {"api_key": "hr_live_fake"}

    @property
    def tool_invoke_params_example(self) -> dict:
        return {"query": "minimum age to serve as a US senator", "max_results": 5}
