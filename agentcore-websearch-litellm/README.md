# AgentCore Web Search × LiteLLM 集成

让 LiteLLM 的 **websearch interception** 后端从 SearXNG 换成 **AWS Bedrock AgentCore
Web Search**，对客户端（Claude Code 等）**零改动**：客户端照常发带原生 `web_search`
的普通请求，LiteLLM 在服务端拦截并用 AgentCore 执行搜索。

> 另一种用法见 [docs/06](docs/06-expose-as-mcp-server.md)：把 AgentCore Web Search 当
> **MCP server** 暴露给无 AWS 凭证的客户端（如 Codex），用 LiteLLM virtual key 鉴权、
> 网关侧 IRSA 签名。与本篇 interception 互补、可并存。

## 这是什么 / 为什么这么做

经过逐层确认（见 [docs/01-background-and-decision.md](docs/01-background-and-decision.md)）：

- **「客户端发普通请求 → 自动搜索」只能靠 interception 机制**，MCP 工具方式做不到透明
  （LiteLLM 不会把 MCP 工具自动注入普通请求）。
- **interception 的搜索后端是闭合枚举**（perplexity/tavily/searxng… 共 17 个），
  不含 AgentCore，也无自定义注册口。
- **最轻的接入方式 = 继承 `WebSearchInterceptionLogger`，只 override `_execute_search`**
  （方案 C2a），把那一次搜索改成走 AgentCore MCP + SigV4。不 fork、不改源码。

## 已验证状态 ✅（生产已切换）

新加坡 EKS（ap-southeast-1）生产 **已从 SearXNG 切到 AgentCore**，客户端零改动端到端测试通过：
真实 `/v1/messages` 带 `web_search` 请求 → interception → IRSA 跨区调 us-east-1 AgentCore →
搜索结果注入回模型。AgentCore 侧 CloudWatch Metrics + vended Logs 双重佐证（见
[docs/04](docs/04-verification-results.md) 验证 6–11）。部署/切换中遇到的全部 bug 见
[docs/05](docs/05-issues-and-gotchas.md)。

| 项 | 值 |
|---|---|
| 集群 | `litellm-cluster` @ ap-southeast-1（account <ACCOUNT_ID>） |
| LiteLLM 版本 | `v1.84.3`（高于 CVE-2026-42271 修复版 1.83.7 ✅） |
| AgentCore Gateway | `<AGENTCORE_GATEWAY_ID>` @ us-east-1（AWS_IAM / MCP / READY） |
| MCP endpoint | `https://<AGENTCORE_GATEWAY_ID>.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp` |
| 工具全名 | `web-search-tool___WebSearch`（实测，非文档里的 `WebSearch`） |
| IRSA role | `<LITELLM_SA_ROLE_NAME>` |
| 已加权限 | inline policy `InvokeAgentCoreWebSearchGW`（仅 `InvokeGateway`） |

## 目录结构

```
agentcore-websearch-litellm/
├── README.md                         ← 本文件（总览 + 索引）
├── src/
│   ├── agentcore_websearch.py        ← 核心实现（C2a：override _execute_search）
│   └── config.snippet.yaml           ← LiteLLM config.yaml 集成片段
├── iam/
│   └── litellm-sa-agentcore-policy.json  ← IRSA 最小权限策略（已应用）
├── verify/
│   ├── probe_agentcore_mcp.py        ← 裸 SigV4 探测 MCP（不依赖 litellm）
│   └── test_execute_search.py        ← e2e 冒烟测试（实例化 logger 调真实搜索）
└── docs/
    ├── 01-background-and-decision.md ← 背景、各方案对比、为什么选 C2a
    ├── 02-deploy-to-eks.md           ← 部署到新加坡 EKS 的步骤（含 callback 加载正解）
    ├── 03-rollout-and-rollback.md    ← 灰度、回退 SearXNG、风险
    ├── 04-verification-results.md    ← 实测记录（链路验证 + 生产切换 6–11）
    ├── 05-issues-and-gotchas.md      ← 所有 bug/踩坑（PYTHONPATH/工具名/签名/日志开通…）
    └── 06-expose-as-mcp-server.md    ← 另一用法：把 AgentCore 当 MCP server 暴露给无凭证客户端
```

## 快速开始

1. 读 [docs/01](docs/01-background-and-decision.md) 理解决策；
2. 按 [docs/02](docs/02-deploy-to-eks.md) 把 `src/agentcore_websearch.py` 挂进 pod
   并改 `config.yaml`；
3. 用 `verify/` 下脚本验证（已在新加坡 pod 验证过，见 [docs/04](docs/04-verification-results.md)）；
4. 上线 / 回退见 [docs/03](docs/03-rollout-and-rollback.md)。

## 已知限制

- AgentCore Web Search 仅 **us-east-1**（本方案已处理跨区 SigV4）。
- query ≤ 200 字符、maxResults 1–25（代码已做截断/默认值）。
- 依赖父类私有方法 `_execute_search` 的返回签名（1.84.x = `str`）。升级 LiteLLM 时
  务必重跑 `verify/`，见 [docs/03](docs/03-rollout-and-rollback.md#升级-litellm-时的回归)。
- AgentCore 计费 $7/1000 次查询；使用条款禁止批量存储结果 / 构建竞争索引。
- AgentCore Gateway 调用日志**默认不开**：Metrics 默认有（`AWS/Bedrock-AgentCore`），
  但请求/响应体 Logs 要手动开 vended log delivery（已开，见 [docs/05 issue #5](docs/05-issues-and-gotchas.md)）。
- 当前是 **live patch**，CDK 重部会覆盖，待回写 CDK（[docs/05 note #6](docs/05-issues-and-gotchas.md)）。
