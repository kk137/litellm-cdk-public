# verify · 验证脚本

| 脚本 | 用途 | 依赖 |
|---|---|---|
| `probe_agentcore_mcp.py` | 裸 SigV4 探测 AgentCore MCP（tools/list + tools/call），确认链路与协议 | boto3, requests（**不需要** litellm） |
| `test_execute_search.py` | e2e 冒烟：实例化 `AgentCoreWebSearchLogger` 调真实 `_execute_search` | litellm, boto3, requests |

## 用法

```bash
# 裸探测（任何有 AWS 凭证 + InvokeGateway 权限的环境）
python3 probe_agentcore_mcp.py "your query"

# e2e（需 litellm；本地装：pip install litellm==1.84.3）
python3 test_execute_search.py "your query"
```

凭证：本地走默认 AWS 链（如 bedrock-admin）；pod 内走 IRSA。
跨区已处理（脚本内 REGION=us-east-1）。

完整实测记录见 [../docs/04-verification-results.md](../docs/04-verification-results.md)。
