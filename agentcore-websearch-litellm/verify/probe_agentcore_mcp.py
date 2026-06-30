#!/usr/bin/env python3
"""
独立探测脚本:用 SigV4 直连 AgentCore Web Search Gateway 的 MCP 端点,
验证 tools/list 与 tools/call 的真实请求/响应结构。

不依赖 LiteLLM —— 纯 boto3(SigV4) + requests，用于确认链路与协议。
用本地 AWS 凭证（需有 bedrock-agentcore:InvokeWebSearch / 调用该 Gateway 的权限）。

用法:
    python3 probe_agentcore_mcp.py "今天有什么 AWS 新闻"
"""
import json
import sys

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest

# --- 真实参数（从集群 + AgentCore 控制面实测得到）---
REGION = "us-east-1"  # AgentCore Web Search 仅此区域
SERVICE = "bedrock-agentcore"
MCP_URL = "https://<AGENTCORE_GATEWAY_ID>.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp"


def sigv4_post(payload: dict) -> requests.Response:
    """对单个 JSON-RPC 请求体做 SigV4 签名并 POST。"""
    body = json.dumps(payload)
    session = boto3.Session()
    creds = session.get_credentials().get_frozen_credentials()

    # MCP streamable-http 要求 Accept 同时含 json 与 event-stream
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    aws_req = AWSRequest(method="POST", url=MCP_URL, data=body, headers=headers)
    SigV4Auth(creds, SERVICE, REGION).add_auth(aws_req)
    return requests.post(
        MCP_URL, data=body, headers=dict(aws_req.headers), timeout=60
    )


def parse_mcp(resp: requests.Response) -> dict:
    """MCP streamable-http 可能返回 SSE（text/event-stream）或纯 JSON。"""
    ctype = resp.headers.get("Content-Type", "")
    text = resp.text
    if "text/event-stream" in ctype:
        for line in text.splitlines():
            if line.startswith("data:"):
                return json.loads(line[len("data:"):].strip())
        raise ValueError(f"SSE 中无 data 行:\n{text}")
    return json.loads(text)


def main():
    query = sys.argv[1] if len(sys.argv) > 1 else "what is amazon bedrock agentcore"

    print("=" * 70)
    print("STEP 1: tools/list —— 发现 WebSearch 工具及其 input schema")
    print("=" * 70)
    r = sigv4_post({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    print("HTTP", r.status_code, "| Content-Type:", r.headers.get("Content-Type"))
    if r.status_code != 200:
        print("BODY:", r.text[:2000])
        sys.exit(1)
    listed = parse_mcp(r)
    print(json.dumps(listed, ensure_ascii=False, indent=2)[:3000])

    # 取出工具名（通常是 WebSearch）
    tools = listed.get("result", {}).get("tools", [])
    if not tools:
        print("!! tools/list 未返回工具，停止")
        sys.exit(1)
    tool_name = tools[0]["name"]

    print()
    print("=" * 70)
    print(f"STEP 2: tools/call —— 调用 '{tool_name}' query={query!r}")
    print("=" * 70)
    r = sigv4_post({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": {"query": query, "maxResults": 5}},
    })
    print("HTTP", r.status_code, "| Content-Type:", r.headers.get("Content-Type"))
    if r.status_code != 200:
        print("BODY:", r.text[:2000])
        sys.exit(1)
    called = parse_mcp(r)
    print(json.dumps(called, ensure_ascii=False, indent=2)[:4000])


if __name__ == "__main__":
    main()
