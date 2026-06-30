# 03 · 灰度、回退与风险

## 灰度建议

LiteLLM 的 callback 是**全局**的（对所有命中 `enabled_providers` 的请求生效），没有
按 key/team 切换 callback 的内置开关。因此灰度推荐用**环境/副本隔离**：

1. **独立验证 deployment**：复制一份 litellm deployment（如 `litellm-canary`），只在它上
   挂 AgentCore callback，把少量流量/特定客户端指过去观察。
2. 确认无误后再切主 deployment 的 config。

> 如需「按 key 决定用 AgentCore 还是 SearXNG」，interception 框架本身做不到（它只认一个
> 后端）。要那种粒度得回到自定义网关层（方案 C1），不在本集成范围内。

## 回退到 SearXNG（最重要）

回退是纯配置操作，**秒级**：

1. 改 `litellm-config` 的 `callbacks`：
   - 去掉 `- agentcore_websearch.agentcore_websearch_logger`
   - 恢复 `- websearch_interception`
   - 确认 `websearch_interception_params`（`search_tool_name: searxng-search`）与
     `search_tools`（searxng）仍在（本集成未删除它们，原样保留）。
2. `kubectl -n litellm rollout restart deployment/litellm`

> 因为 SearXNG 部署、`search_tools` 配置都没动，回退不需要重建任何东西。

如需进一步**移除权限**：
```bash
aws iam delete-role-policy \
  --role-name litellm-Cluster-ClusterLitellmSaRoleB6A0F44D-K4BkyERtnoUn \
  --policy-name InvokeAgentCoreWebSearchGW
```

## 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `_execute_search` 私有方法签名变更 | 升级 LiteLLM 后搜索报错 | 升级前重跑 `verify/`，见下节 |
| AgentCore 跨区延迟（sg→us-east-1） | 搜索 RT 增加 | 监控 RT；AgentCore 无其他区域可选 |
| AgentCore 单区域故障 | 搜索不可用 | 回退 SearXNG（秒级） |
| 费用（$7/1k 查询） | 成本 | 监控调用量；interception 仅在含 web_search 的请求触发 |
| 条款：禁止批量存储结果 | 合规 | 不要把结果落库做缓存/索引 |
| callback 双开冲突 | 行为异常 | 确保同一时间只启用一个 websearch callback |

## 升级 LiteLLM 时的回归

C2a 依赖父类私有方法。**每次升级 LiteLLM 镜像前**，在目标版本上跑：

```bash
# 在目标版本的 venv 或 pod 里
python3 -c "
from litellm.integrations.websearch_interception.handler import WebSearchInterceptionLogger
import inspect
print('_execute_search:', inspect.signature(WebSearchInterceptionLogger._execute_search))
"
```

- 若仍是 `(self, query: str) -> str` → 现有实现可用。
- 若变成 `-> Tuple[str, SearchResponse]`（main 分支形态）→ 需把
  `src/agentcore_websearch.py` 的 `_execute_search` 返回值改回元组
  （`return text, search_response`），并恢复 `_to_search_response` 的 structured 返回。
  代码里已保留相关注释与 `_to_search_response` 实现，改动很小。

然后跑 `verify/test_execute_search.py` 确认端到端通。
