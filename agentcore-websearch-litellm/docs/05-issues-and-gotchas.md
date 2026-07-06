# 05 · 实战问题与踩坑记录

部署到新加坡 EKS + 切换生产 + 配后端日志过程中遇到的全部问题，按发现顺序记录。
每条含：现象 → 根因 → 解法 → 状态。

---

## bug #1 · PYTHONPATH 方式加载 callback 行不通，pod CrashLoop

**现象**
按 docs/02 早期写的"做法 A：挂 .py 到 `/extra-code` + 设 `PYTHONPATH=/extra-code`"部署后，
新 pod CrashLoopBackOff：
```
ImportError: Could not find module file /app/config/agentcore_websearch.py
...
ImportError: Could not import agentcore_websearch_logger from agentcore_websearch
```

**根因**
LiteLLM 的 `litellm/proxy/types_utils/utils.py::get_instance_fn` 在 `config_file_path`
非空时（proxy 模式下恒为 `/app/config/config.yaml`），用
`os.path.join(os.path.dirname(config_file_path), *module_name.split("."))  + ".py"`
按**相对 config.yaml 目录**的路径找模块文件，**完全不查 `PYTHONPATH` / `sys.path`**。
所以无论 PYTHONPATH 指哪，它只会去 `/app/config/agentcore_websearch.py` 找。

**解法**
把 `agentcore_websearch.py` 放进 `litellm-config` ConfigMap（与 config.yaml 同 key 空间），
二者一起挂在 `/app/config`，模块就在它要找的目录。撤掉 `/extra-code` volume 和 PYTHONPATH。
改完 3 pod 全 Running，`Application startup complete`。

**状态**：✅ 已修，docs/02 做法 A 已重写。

> 注：`PYTHONPATH=/extra-code` 这个残留 env 留着无害（目录还在、不影响 import 逻辑），
> 但回写 CDK 时应去掉，避免误导。

---

## bug #2 · 真实工具名不是文档示例的 `WebSearch`

**现象**
按 AWS 示例用工具名 `WebSearch` 调 `tools/call`，报工具不存在。

**根因**
AgentCore Gateway 的工具全名 = `<connector target 名>___<工具名>`。本 gateway 的 target
叫 `web-search-tool`，所以真实工具名是 **`web-search-tool___WebSearch`**（三个下划线分隔），
不是 AWS 文档示例里裸的 `WebSearch`。

**解法**
代码默认值用全名 `web-search-tool___WebSearch`，并可被 `AGENTCORE_WS_TOOL_NAME` env 覆盖。
换 gateway/target 时用 `tools/list` 先列真实名。

**状态**：✅ 已处理（代码默认值 + env 可覆盖）。

---

## bug #3 · `_execute_search` 是私有方法，返回签名随 LiteLLM 版本变

**现象**
依赖父类 `WebSearchInterceptionLogger._execute_search`，但它在不同 LiteLLM 版本返回类型不同。

**根因**
- 1.84.x（当前集群）：`_execute_search(query) -> str`
- main 分支较新版本：`-> (str, SearchResponse)`（带 native citation 块）

本实现针对 1.84.3 的 `-> str`。升级 LiteLLM 镜像可能让它变成元组，导致拼接逻辑出错。

**解法 / 防回归**
升级 LiteLLM 前必跑签名检查：
```bash
python3 -c "
from litellm.integrations.websearch_interception.handler import WebSearchInterceptionLogger
import inspect
print(inspect.signature(WebSearchInterceptionLogger._execute_search))
"
```
若变成 `-> Tuple[str, SearchResponse]`，把 `_execute_search` 改回返回元组（代码里保留了
`_to_search_response` 的 structured 实现，改动很小）。详见 docs/03 §升级回归。

**状态**：⚠️ 设计性风险，已用 verify/ 脚本 + docs/03 流程覆盖。每次升级必查。

---

## issue #4 · AgentCore Gateway 默认无调用日志，后端查不到调用记录

**现象**
想从后端确认 LiteLLM 是否真的调了 AgentCore，但：
- gateway `<AGENTCORE_GATEWAY_ID>` 在 CloudWatch 没有 vendedlogs 日志组
- CloudTrail 只有控制面操作（ListGateways/GetGateway/CreateGateway），**没有数据面
  `InvokeGateway` / `tools/call`**

**根因**
两点叠加：
1. AgentCore gateway 的 **Logs（请求/响应体）是 opt-in 的**——创建 gateway 时不自动配
   log destination（官方文档明确：memory/gateway 不自动建日志组）。
2. 数据面调用（InvokeGateway / MCP tools/call）**不进 CloudTrail 管理事件**（同
   Bedrock InvokeModel 一样）。

**解法（分两层）**
- **Metrics（默认就有）**：CloudWatch namespace `AWS/Bedrock-AgentCore`，按
  `Operation=InvokeGateway` / `Method=tools/call` / `Resource=<gateway ARN>` 维度记
  Invocations/Latency/Errors。能证明"调了几次"，无需任何配置。查询见下。
- **Logs（需手动开，见 issue #5）**：配 vended log delivery 后能看到每次调用的
  `requestBody`（搜索词）+ `responseBody`（结果）+ trace_id。

查 Invocations 计数（验证调用真实发生）：
```bash
aws cloudwatch get-metric-statistics --region us-east-1 \
  --namespace "AWS/Bedrock-AgentCore" --metric-name Invocations \
  --dimensions Name=Resource,Value=arn:aws:bedrock-agentcore:us-east-1:<ACCOUNT_ID>:gateway/<AGENTCORE_GATEWAY_ID> \
              Name=Operation,Value=InvokeGateway Name=Method,Value=tools/call Name=Protocol,Value=MCP \
  --start-time <start> --end-time <end> --period 300 --statistics Sum --output table
```

**状态**：✅ 已解释清楚 + 已开 Logs（见 issue #5）。

---

## issue #5 · 开启 AgentCore Gateway 的 vended logs（请求/响应体）

**目标**：后端能查到每次搜索的 query 和返回结果。

**做法**：AgentCore gateway 的 APPLICATION_LOGS 走 CloudWatch Logs vended log delivery，
通过 `logs` API 配（不是改 gateway 本身），4 步：

```bash
REGION=us-east-1
GW_ID=<AGENTCORE_GATEWAY_ID>
GW_ARN=arn:aws:bedrock-agentcore:us-east-1:<ACCOUNT_ID>:gateway/$GW_ID
LG=/aws/vendedlogs/bedrock-agentcore/gateway/APPLICATION_LOGS/$GW_ID
LG_ARN=arn:aws:logs:$REGION:<ACCOUNT_ID>:log-group:$LG

# Step 0: 建 log group
aws logs create-log-group --region $REGION --log-group-name "$LG"

# Step 1: delivery source (APPLICATION_LOGS)
aws logs put-delivery-source --region $REGION \
  --name "${GW_ID}-app-logs-source" --log-type APPLICATION_LOGS --resource-arn "$GW_ARN"

# Step 2: delivery destination (CWL)
aws logs put-delivery-destination --region $REGION \
  --name "${GW_ID}-app-logs-dest" --delivery-destination-type CWL \
  --delivery-destination-configuration "destinationResourceArn=$LG_ARN"

# Step 3: create delivery (连 source → destination)
DEST_ARN=$(aws logs describe-delivery-destinations --region $REGION \
  --query "deliveryDestinations[?name=='${GW_ID}-app-logs-dest'].arn|[0]" --output text)
aws logs create-delivery --region $REGION \
  --delivery-source-name "${GW_ID}-app-logs-source" --delivery-destination-arn "$DEST_ARN"
```

**查询日志**（落盘约 1 分钟延迟）：
```bash
aws logs filter-log-events --region us-east-1 \
  --log-group-name "/aws/vendedlogs/bedrock-agentcore/gateway/APPLICATION_LOGS/<AGENTCORE_GATEWAY_ID>" \
  --start-time $(($(date +%s)*1000 - 3600000)) \
  --query 'events[*].message' --output text | python3 -m json.tool
```

日志样例（实测，含搜索词）：
```json
{
  "body": {
    "log": "Started processing request",
    "requestBody": "{...method=tools/call, params={name=web-search-tool___WebSearch,
                     arguments={maxResults=10, query=Amazon Bedrock Nova 3 模型 2026 发布}}}"
  },
  "request_id": "4a58c20e-...",
  "trace_id": "6a38fa38...",
  "span_id": "d2cfe704..."
}
```

**已建资源（us-east-1，可独立删除回退）**：
- log group `/aws/vendedlogs/bedrock-agentcore/gateway/APPLICATION_LOGS/<AGENTCORE_GATEWAY_ID>`
- delivery source `<AGENTCORE_GATEWAY_ID>-app-logs-source`
- delivery destination `<AGENTCORE_GATEWAY_ID>-app-logs-dest`
- delivery（连接二者）

**未做**：TRACES（vended spans）。需先开 CloudWatch Transaction Search（账号级，影响 X-Ray
计费）。本次只要"查调用内容"，APPLICATION_LOGS 已足够；要分布式追踪再补。

**状态**：✅ 已开通并实测落盘。

---

## note #6 · 这是 live patch，CDK 重部会覆盖

**现象**：切换 AgentCore 用的是 `kubectl patch deployment` + `kubectl apply configmap`，
不是改 CDK 代码。

**影响**：下次 `cdk deploy litellm-Cluster` 会把 deployment/config 冲回 SearXNG（CDK 是
真源）。

**对策**：稳定后需把以下回写进 CDK（cluster-stack.ts）：
- `litellm-config` ConfigMap 加 `agentcore_websearch.py` 这个 key
- config.yaml 的 callbacks 改 agentcore
- deployment 加 3 个 `AGENTCORE_WS_*` env
- IRSA role 加 `InvokeGateway` policy（iam/litellm-sa-agentcore-policy.json）

**状态**：⏳ 待回写 CDK。回退随时可做（秒级，见 docs/03）。

---

## note #7 · DEBUG 出站日志会打印临时 STS 凭证

**现象**：为做铁证，在 pod 内用 `logging.basicConfig(level=DEBUG)` 跑 `_execute_search`，
botocore DEBUG 把 `AssumeRoleWithWebIdentity` 的响应（含临时 AccessKey/SecretKey/SessionToken）
打到了终端。

**影响**：是临时凭证（约 1 小时过期），但仍是敏感信息，**不要复制到公开地方 / git / 工单**。

**对策**：生产日志级别保持 INFO（`LITELLM_LOG=INFO` + `set_verbose=false`，已确认）。
只在临时一次性进程里开 DEBUG，跑完即弃，不改 live pod 日志级别。

**状态**：✅ 生产无 DEBUG 残留。

---

## 升级 / 回退 / 安全清单速查

| 动作 | 命令 / 参考 |
|---|---|
| 回退到 SearXNG | docs/03 §回退（改 callbacks + rollout restart，秒级） |
| 升级 LiteLLM 前 | 跑 bug #3 的签名检查 + verify/ 脚本 |
| 查 AgentCore 调用次数 | issue #4 的 get-metric-statistics |
| 查每次搜索 query/结果 | issue #5 的 filter-log-events |
| 删除 vended logs | 删 delivery → delivery-destination → delivery-source → log group |
