"""
AgentCore Web Search backend for LiteLLM's websearch interception.

方案 C2a:继承内置的 WebSearchInterceptionLogger，只 override 唯一的搜索收口
方法 `_execute_search`，把后端从 SearXNG/Perplexity 换成 AWS Bedrock AgentCore
Web Search（通过 MCP + SigV4）。其余 agentic-loop / 消息拼接 / 流式 / native
citation blocks 全部复用父类，不 fork、不改 LiteLLM 源码、客户端零改动。

为什么不用 search_provider 配置：LiteLLM 的 search_provider 是闭合枚举
（perplexity/tavily/searxng/... 共 17 个），不含 bedrock-agentcore，也无自定义
注册口。override `_execute_search` 是绕过该限制的最轻路径。

⚠️ 依赖父类的“私有”方法 `_execute_search(query)`。其返回签名随版本变化：
   - LiteLLM 1.84.x（当前集群）: `-> str`（纯文本，无 native citation 块）
   - main 分支较新版本: `-> (str, SearchResponse)`（带原生引用块）
   本实现针对 **1.84.3**，返回 str。升级 LiteLLM 时务必用 verify/ 下的脚本
   回归此签名（见 inspect.signature 检查）。
"""
import json
import os

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

from litellm._logging import verbose_logger
from litellm.integrations.websearch_interception.handler import (
    WebSearchInterceptionLogger,
)
from litellm.integrations.websearch_interception.transformation import (
    WebSearchTransformation,
)
from litellm.llms.base_llm.search.transformation import (
    SearchResponse,
    SearchResult,
)

# --- 配置：可被环境变量覆盖（K8s 里走 env / secret 注入）---
# AgentCore Web Search 仅在 us-east-1，跨区调用时 SigV4 的 region 必须是 us-east-1，
# 而不是 Pod 所在的 ap-southeast-1。
AGENTCORE_REGION = os.environ.get("AGENTCORE_WS_REGION", "us-east-1")
AGENTCORE_SERVICE = "bedrock-agentcore"
AGENTCORE_MCP_URL = os.environ.get(
    "AGENTCORE_WS_MCP_URL",
    "https://<AGENTCORE_GATEWAY_ID>.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
)
# 实测的真实工具全名（connector target 名 + ___ + WebSearch）。
AGENTCORE_TOOL_NAME = os.environ.get(
    "AGENTCORE_WS_TOOL_NAME", "web-search-tool___WebSearch"
)
AGENTCORE_MAX_RESULTS = int(os.environ.get("AGENTCORE_WS_MAX_RESULTS", "10"))


class AgentCoreWebSearchLogger(WebSearchInterceptionLogger):
    """websearch interception，但搜索后端走 AgentCore Web Search (MCP + SigV4)。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        # boto3 在 Pod 内走 IRSA 凭证链（litellm-sa role）；本地走默认链。
        self._session = boto3.Session()

    def _sigv4_post(self, payload: dict) -> requests.Response:
        body = json.dumps(payload)
        creds = self._session.get_credentials().get_frozen_credentials()
        headers = {
            "Content-Type": "application/json",
            # MCP streamable-http 要求同时接受 json 与 event-stream
            "Accept": "application/json, text/event-stream",
        }
        aws_req = AWSRequest(
            method="POST", url=AGENTCORE_MCP_URL, data=body, headers=headers
        )
        SigV4Auth(creds, AGENTCORE_SERVICE, AGENTCORE_REGION).add_auth(aws_req)
        return requests.post(
            AGENTCORE_MCP_URL, data=body, headers=dict(aws_req.headers), timeout=60
        )

    @staticmethod
    def _parse_mcp(resp: requests.Response) -> dict:
        """AgentCore 当前返回纯 JSON；同时兼容 SSE（text/event-stream）。"""
        if "text/event-stream" in resp.headers.get("Content-Type", ""):
            for line in resp.text.splitlines():
                if line.startswith("data:"):
                    return json.loads(line[len("data:"):].strip())
            raise ValueError("MCP SSE 响应中无 data 行")
        return json.loads(resp.text)

    async def _execute_search(self, query: str) -> str:
        """
        override 父类的搜索收口（1.84.3 签名: -> str）：用 AgentCore Web Search
        执行单次查询，返回格式化文本供父类拼进 follow-up 的 tool_result。

        失败时抛异常，由父类的 asyncio.gather(return_exceptions=True) 兜住。
        """
        verbose_logger.debug(
            f"AgentCoreWebSearch: query={query!r} via {AGENTCORE_MCP_URL}"
        )
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": AGENTCORE_TOOL_NAME,
                "arguments": {
                    "query": query[:200],  # AgentCore 硬限制 200 字符
                    "maxResults": AGENTCORE_MAX_RESULTS,
                },
            },
        }
        resp = self._sigv4_post(payload)
        if resp.status_code != 200:
            raise RuntimeError(
                f"AgentCore MCP HTTP {resp.status_code}: {resp.text[:500]}"
            )
        parsed = self._parse_mcp(resp)
        if "error" in parsed:
            raise RuntimeError(f"AgentCore MCP error: {parsed['error']}")

        # result.content[0].text 是一个内层 JSON 字符串
        content = parsed.get("result", {}).get("content", [])
        raw_text = next(
            (c.get("text", "") for c in content if c.get("type") == "text"), ""
        )
        try:
            inner = json.loads(raw_text)
        except json.JSONDecodeError:
            inner = {"results": []}
        results = inner.get("results", [])

        # 映射成 LiteLLM 的 SearchResponse，再复用父类的格式化，
        # 保证喂回模型的文本与内置 provider 完全一致。
        search_response = self._to_search_response(query, results)
        text = WebSearchTransformation.format_search_response(search_response)
        verbose_logger.debug(
            f"AgentCoreWebSearch: got {len(results)} result(s), {len(text)} chars"
        )
        return text

    @staticmethod
    def _to_search_response(query: str, results: list) -> SearchResponse:
        """把 AgentCore 的 results[] 转成 LiteLLM SearchResponse（Pydantic）。

        字段对齐 SearchResult: title / url / snippet / date。AgentCore 的
        正文在 "text"、发布时间在 "publishedDate"。model_config extra=allow，
        故额外字段可留作 debug 但非必需。
        """
        search_results = []
        for r in results:
            search_results.append(
                SearchResult(
                    title=r.get("title", "") or "",
                    url=r.get("url", "") or "",
                    snippet=r.get("text", "") or "",
                    date=r.get("publishedDate"),
                )
            )
        return SearchResponse(results=search_results)


# 供 LiteLLM config.yaml 的 callbacks 引用的模块级实例。
# config 写：callbacks: ["agentcore_websearch.agentcore_websearch_logger"]
agentcore_websearch_logger = AgentCoreWebSearchLogger(
    enabled_providers=["bedrock", "bedrock_converse"],
)
