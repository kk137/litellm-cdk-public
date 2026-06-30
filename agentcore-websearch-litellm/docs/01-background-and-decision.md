# 01 · 背景与方案决策

## 诉求

客户端（主要是 Claude Code，经由 Bedrock）发起普通查询请求时，希望**自动用上更好的
web 搜索**，且**客户端零改动**。当前生产已用 LiteLLM 的 websearch interception 接
SearXNG，现在评估能否换成 AWS Bedrock AgentCore Web Search。

## 关键结论（逐层确认得来）

### 1. AgentCore Web Search 的形态与限制

- 是 **AgentCore Gateway 上的一个 MCP 连接器**（`connectorId: web-search`），不是独立
  REST API。
- query ≤ **200 字符**；maxResults **1–25**（默认 10）。
- 仅 **us-east-1**。
- 计费 **$7 / 1000 次**；条款禁止批量存储结果 / 构建竞争索引；须保留来源引用。
- 鉴权：该 Gateway 用 **AWS_IAM**（即 SigV4）。

### 2. LiteLLM 的 search_provider 是闭合枚举

源码确认（`litellm/utils.py` 的 `get_provider_search_config` + `litellm/types/utils.py`
的 `SearchProviders` 枚举）：合法 provider 只有 17 个硬编码值（perplexity / tavily /
searxng / exa_ai / brave / …），**不含 bedrock-agentcore，且无自定义注册口**
（没有 `custom_search_provider_map` 之类）。

→ **不能**通过 `search_tool_name` / `search_provider` 配置把 interception 指向 AgentCore。

### 3. MCP 工具方式无法对客户端透明

LiteLLM 官方文档确认：proxy **不会**把配置的 MCP 工具自动注入普通 `/chat/completions`
请求。客户端必须在 `tools` 数组里显式声明 MCP 工具（且 `require_approval: "never"`
才会服务端自动执行）。

→ MCP 方式要求客户端改请求，**不满足「零改动」**。

### 4. interception 的实现是可继承的 CustomLogger

`WebSearchInterceptionLogger` 是个标准 `CustomLogger`，搜索逻辑收口在单个方法
`_execute_search`。只要 override 它，就能换后端，**其余 agentic-loop / 消息拼接全部复用**。

> 注意：interception 机制本身**强制非流式**——源码在 pre-call hook 主动把 `stream=True`
> 改成 `stream=False`（要拿到完整响应才能拦 `tool_use`）。换后端不改变这一点。想要「流式 +
> 搜索」需走客户端 MCP（见 [06](06-expose-as-mcp-server.md)），把拦截从网关移到客户端。

## 方案对比

| 方案 | 客户端改动 | 透明自动搜索 | 改 LiteLLM 源码 | 维护成本 | 结论 |
|---|---|---|---|---|---|
| 维持 SearXNG | 无 | ✅ | 无 | 低 | 基线 |
| MCP 工具暴露 | **要声明工具** | ❌ | 无 | 中 | 不满足诉求 |
| Fork 加 `bedrock_agentcore` provider | 无 | ✅ | **要 fork** | 高（rebase upstream） | 可行但重 |
| **C2a：继承 + override `_execute_search`** | 无 | ✅ | **不改** | 中 | **选定** |

## 为什么选 C2a

- 满足「客户端零改动 + 透明自动搜索」（复用 interception 框架）。
- 不 fork、不动枚举，升级 LiteLLM 只需关注一个私有方法签名。
- 部署轻：一个 `.py` + config 引用即可，可用 ConfigMap 挂载先验证。

## C2a 的唯一风险点

`_execute_search` 是「私有」方法，返回签名随版本变化：

- **1.84.x（当前集群）**：`-> str`
- main 分支较新版本：`-> (str, SearchResponse)`（带 native citation 块）

本实现针对 **1.84.3 返回 `str`**。升级 LiteLLM 前必须重跑 `verify/`，见
[03-rollout-and-rollback.md](03-rollout-and-rollback.md#升级-litellm-时的回归)。
