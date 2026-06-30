#!/usr/bin/env python3
"""
e2e 冒烟测试:实例化 AgentCoreWebSearchLogger，直接调真实的 _execute_search，
验证 SigV4 → AgentCore MCP → SearchResponse → format 整条链。

需要 LiteLLM 已安装（pip install litellm）+ 可用 AWS 凭证。
本地用 bedrock-admin；Pod 里用 IRSA。

用法:
    python3 test_execute_search.py "what is amazon bedrock agentcore"
"""
import asyncio
import sys

sys.path.insert(0, "../src")
from agentcore_websearch import AgentCoreWebSearchLogger  # noqa: E402


async def main():
    query = sys.argv[1] if len(sys.argv) > 1 else "what is amazon bedrock agentcore"
    logger = AgentCoreWebSearchLogger(enabled_providers=["bedrock"])

    print(f"调用 _execute_search(query={query!r}) ... (1.84.3 签名: -> str)")
    text = await logger._execute_search(query)

    print("=" * 70)
    print("格式化文本（喂回模型的 tool_result 内容）:")
    print("=" * 70)
    print(text[:2500])

    assert text and "Title:" in text, "结果为空或格式不符 —— 链路有问题"
    assert "URL:" in text, "结果缺少 URL"
    print()
    print("✅ PASS: AgentCore Web Search 链路打通，_execute_search 返回格式化文本")


if __name__ == "__main__":
    asyncio.run(main())
