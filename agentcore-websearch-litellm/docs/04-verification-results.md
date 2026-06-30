# 04 · 验证记录（实测）

日期：2026-06-22 · 集群：`litellm-cluster` @ ap-southeast-1 · LiteLLM `v1.84.3`

## 验证矩阵

| # | 验证项 | 凭证 | 路径 | 结果 |
|---|---|---|---|---|
| 1 | 裸 SigV4 调 MCP（tools/list + tools/call） | 本地 bedrock-admin | 本机 → us-east-1 | ✅ HTTP 200 |
| 2 | logger._execute_search e2e | 本地 bedrock-admin | 本机 → us-east-1 | ✅ PASS |
| 3 | IRSA 权限缺失时 | IRSA（litellm-sa） | sg pod → us-east-1 | ✅ 预期 403 |
| 4 | 加权限后裸 SigV4（跨区） | IRSA（litellm-sa） | sg pod → us-east-1 | ✅ HTTP 200 |
| 5 | 加权限后 logger e2e（跨区） | IRSA（litellm-sa） | sg pod → us-east-1 | ✅ PASS |

## 关键发现

1. **真实工具名是 `web-search-tool___WebSearch`**（= connector target 名 `web-search-tool`
   + `___` + `WebSearch`），**不是** AWS 文档示例里的 `WebSearch`。代码用此全名，可被
   `AGENTCORE_WS_TOOL_NAME` 覆盖。
2. **1.84.3 的 `_execute_search` 返回 `str`**（非 main 分支的元组），实现据此适配。
3. **AgentCore 返回结构**：`result.content[0].text` 是内层 JSON 字符串，
   形如 `{"id":..,"results":[{publishedDate,text,title,url},...]}`。
4. **跨区可行**：Pod 在 ap-southeast-1，SigV4 region 设 us-east-1，调用成功。

## 复现命令

### 1 / 2 · 本地（bedrock-admin）

```bash
cd verify
python3 probe_agentcore_mcp.py "latest AWS Bedrock AgentCore news June 2026"
# → STEP1 tools/list HTTP 200，工具名 web-search-tool___WebSearch
# → STEP2 tools/call HTTP 200，返回真实新闻

# e2e（需 litellm 已装）
python3 test_execute_search.py "latest AWS Bedrock AgentCore announcements 2026"
# → ✅ PASS: 返回格式化文本（Title/URL/Snippet）
```

### 3 · IRSA 权限缺失（预期 403）

```bash
POD=$(kubectl -n litellm get pod -o name | grep litellm | head -1 | cut -d/ -f2)
kubectl -n litellm cp verify/probe_agentcore_mcp.py litellm/$POD:/tmp/probe.py
kubectl -n litellm exec $POD -- python3 /tmp/probe.py "test"
# → HTTP 403 {"error":{"code":-32002,"message":"Authorization error - Insufficient permissions"}}
#   证明链路/签名正确，仅差权限。
```

### 加权限

```bash
aws iam put-role-policy \
  --role-name litellm-Cluster-ClusterLitellmSaRoleB6A0F44D-K4BkyERtnoUn \
  --policy-name InvokeAgentCoreWebSearchGW \
  --policy-document file://iam/litellm-sa-agentcore-policy.json
```

### 4 / 5 · 加权限后 sg pod 内（IRSA，跨区）

```bash
# 裸 SigV4（IAM 传播可能需重试几次）
kubectl -n litellm exec $POD -- python3 /tmp/probe.py "latest AWS news June 2026"
# → HTTP 200，返回 "Top announcements of the AWS Summit in New York, 2026" 等真实结果

# e2e logger（在真实 pod litellm 1.84.3 环境）
kubectl -n litellm cp src/agentcore_websearch.py litellm/$POD:/tmp/agentcore_websearch.py
kubectl -n litellm cp verify/test_execute_search.py litellm/$POD:/tmp/test_execute_search.py
kubectl -n litellm exec $POD -- sh -c 'cd /tmp && python3 test_execute_search.py "AWS Graviton5 EC2 M9g instances 2026"'
# → ✅ PASS: 返回 EC2 M9g/Graviton5 真实公告（Title/URL/Snippet）

# 清理
kubectl -n litellm exec $POD -- rm -f /tmp/probe.py /tmp/agentcore_websearch.py /tmp/test_execute_search.py
```

## 实测输出节选（验证 5）

```
Title: Amazon EC2 M9g and M9gd general purpose instances are now available
URL: https://aws.amazon.com/about-aws/whats-new/2026/06/ec2-m9g-m9gd-instances-graviton5-processors-available/
Snippet: ... AWS Graviton5 processors ... generally available ...

✅ PASS: AgentCore Web Search 链路打通，_execute_search 返回格式化文本
```

## 验证后的环境状态（链路验证阶段）

- **已变更（持久）**：IRSA role 上新增 inline policy `InvokeAgentCoreWebSearchGW`。
- **未变更**：pod 内临时文件已清理；LiteLLM config / callbacks 尚未改动。本阶段仅验证链路。

---

## 生产切换验证（2026-06-22，已切换并实测）

链路验证通过后，**已把新加坡生产从 SearXNG 切到 AgentCore**，并端到端实测。

### 部署动作（live patch）

1. 把 `agentcore_websearch.py` 放进 `litellm-config` ConfigMap（与 config.yaml 同目录
   `/app/config`——见 [05 bug #1](05-issues-and-gotchas.md#bug-1)，**不是** PYTHONPATH 方式）。
2. config.yaml callbacks：`websearch_interception`（SearXNG）→ `agentcore_websearch.agentcore_websearch_logger`。
3. deployment 注入 `AGENTCORE_WS_REGION/MCP_URL/TOOL_NAME` env。
4. `rollout restart` → 3 pod 全 Running，`Application startup complete`（无 ImportError）。

### 端到端实测（真实 API + 客户端路径）

| # | 验证 | 方法 | 结果 |
|---|---|---|---|
| 6 | callback 加载 | pod 日志无 ImportError | ✅ startup complete |
| 7 | pod 内 e2e | exec 调 `_execute_search` | ✅ 返回真实结果 |
| 8 | **真实 API interception** | `POST /v1/messages` 带 `web_search` 工具 | ✅ input_tokens 12K–13K（搜索内容已注入），答案为真实最新信息 |
| 9 | **出站铁证** | pod 内 DEBUG 抓 botocore | ✅ 见下 |
| 10 | **AgentCore 侧 Metrics** | CloudWatch `tools/call` Invocations | ✅ 计数随测试增长 |
| 11 | **AgentCore 侧 Logs** | vended logs requestBody | ✅ 记到真实 query（含中文） |

### 验证 9 出站铁证（DEBUG 日志关键行）

```
AgentCoreWebSearch: query='...' via https://<AGENTCORE_GATEWAY_ID>...us-east-1.../mcp
AssumeRoleWithWebIdentity  RoleArn=...litellm-Cluster-ClusterLitellmSaRole...
SubjectFromWebIdentityToken: system:serviceaccount:litellm:litellm-sa   ← pod 身份
签名: .../us-east-1/bedrock-agentcore/aws4_request                       ← 跨区 SigV4
POST /mcp HTTP/1.1" 200                                                  ← gateway 200
got 10 result(s), 21288 chars
```
证明：litellm pod **用自己的 IRSA 身份**、**跨区**（sg→us-east-1）SigV4 调 AgentCore，HTTP 200。

> ⚠️ DEBUG 会打印临时 STS 凭证，见 [05 note #7](05-issues-and-gotchas.md)。生产保持 INFO。

### 验证 11 后端日志铁证

开通 gateway vended logs 后（见 [05 issue #5](05-issues-and-gotchas.md#issue-5)），
log group `/aws/vendedlogs/bedrock-agentcore/gateway/APPLICATION_LOGS/<AGENTCORE_GATEWAY_ID>`
记到每次调用的请求体：
```json
"requestBody": "{...method=tools/call, params={name=web-search-tool___WebSearch,
                 arguments={maxResults=10, query=Amazon Bedrock Nova 3 模型 2026 发布}}}"
```

### 当前生产状态

- **新加坡生产 web search 后端 = AgentCore**（已切换，客户端零改动测试通过）。
- 这是 **live patch**，CDK 重部会覆盖，待回写 CDK——见 [05 note #6](05-issues-and-gotchas.md)。
- 回退秒级，见 [03](03-rollout-and-rollback.md)。
