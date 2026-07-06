# 02 · 部署到新加坡 EKS

集群：`litellm-cluster` @ ap-southeast-1，namespace `litellm`，deployment `litellm`（3 副本）。

## 前置：IAM 权限（已完成）

LiteLLM pod 走 IRSA（serviceaccount `litellm-sa` → role
`<LITELLM_SA_ROLE_NAME>`）。role 名是 CFN 生成的,先查你自己环境的:

```bash
kubectl get sa litellm-sa -n litellm \
  -o jsonpath='{.metadata.annotations.eks\.amazonaws\.com/role-arn}'
```

已加最小权限 inline policy：

```bash
aws iam put-role-policy \
  --role-name <LITELLM_SA_ROLE_NAME> \
  --policy-name InvokeAgentCoreWebSearchGW \
  --policy-document file://iam/litellm-sa-agentcore-policy.json
```

策略内容（仅 `InvokeGateway` on 那个 Gateway，见 `iam/litellm-sa-agentcore-policy.json`）。

> AWS Web Search 工具的鉴权是 per-invocation 针对 Gateway ARN 的，因此只需
> `bedrock-agentcore:InvokeGateway`。

## 让 LiteLLM 加载自定义 callback 模块

LiteLLM 用 `"模块名.实例名"` 解析 callback。

> ⚠️ **关键(踩过坑，见 [bug #1](05-issues-and-gotchas.md)）**：LiteLLM `get_instance_fn` 在 `config_file_path`
> 非空时（proxy 模式恒为 `/app/config/config.yaml`），**强制**去 config.yaml 所在目录
> （`/app/config`）按相对路径找 `<模块名>.py`，**完全忽略 `PYTHONPATH`**。所以 .py 必须和
> config.yaml **同目录**。把 .py 单独挂到 `/extra-code` + 设 PYTHONPATH 会 CrashLoop：
> `ImportError: Could not find module file /app/config/agentcore_websearch.py`。

### 做法 A（推荐先用来验证）：把 .py 放进 litellm-config ConfigMap

`config.yaml` 本身就在 `litellm-config` ConfigMap、挂在 `/app/config`。把 `.py` 加进**同一个**
ConfigMap，二者就同目录了——不需要额外 volume，也不需要 PYTHONPATH。

```bash
# 用 --from-file 同时带 config.yaml(改好的) + .py，覆盖 litellm-config
# (litellm-config 只有 config.yaml 一个 key，这样覆盖是安全的；多 key 时需保留其余 key)
kubectl -n litellm create configmap litellm-config \
  --from-file=config.yaml=/path/to/your-edited-config.yaml \
  --from-file=agentcore_websearch.py=src/agentcore_websearch.py \
  --dry-run=client -o yaml | kubectl apply -f -
```

然后只需在 deployment 注入 env（**不需要** PYTHONPATH / 额外 volume）：

```yaml
spec:
  template:
    spec:
      containers:
        - name: litellm
          env:
            - name: AGENTCORE_WS_REGION
              value: us-east-1               # 必须 us-east-1（跨区签名）
            - name: AGENTCORE_WS_MCP_URL
              value: https://<AGENTCORE_GATEWAY_ID>.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp
            - name: AGENTCORE_WS_TOOL_NAME
              value: web-search-tool___WebSearch
```

patch 命令：
```bash
kubectl -n litellm patch deployment litellm --patch '
spec:
  template:
    spec:
      containers:
        - name: litellm
          env:
            - {name: AGENTCORE_WS_REGION, value: us-east-1}
            - {name: AGENTCORE_WS_MCP_URL, value: "https://<AGENTCORE_GATEWAY_ID>.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp"}
            - {name: AGENTCORE_WS_TOOL_NAME, value: web-search-tool___WebSearch}
'
```

> 注：实测时先误按"挂 /extra-code + PYTHONPATH"做，pod CrashLoop；改成本做法（.py 进
> litellm-config 同目录）后 3 pod 全部 Running。详见 [bug #1](05-issues-and-gotchas.md)。

### 做法 B（长期）：打进镜像

把 `agentcore_websearch.py` 放进自定义镜像的 `/app/config`（与 config.yaml 同目录），重建镜像。
适合稳定后固化。注意目录必须是 config.yaml 所在目录，不是 `/app`。

## 改 config.yaml

当前 config 在 ConfigMap `litellm-config`（key `config.yaml`）。按
`src/config.snippet.yaml` 修改 `callbacks`：

- **移除/注释** `- websearch_interception`（原 SearXNG）
- **加入** `- agentcore_websearch.agentcore_websearch_logger`

> 二者不可并存——都拦截 bedrock 的 web_search，会冲突。

应用：

```bash
# 编辑 ConfigMap（建议先导出改完再 apply，而非直接 edit 生产）
kubectl -n litellm get configmap litellm-config -o yaml > /tmp/litellm-config.bak.yaml
# ... 修改 callbacks ...
kubectl -n litellm apply -f <改好的文件>
```

## 重载

LiteLLM 不会热加载 ConfigMap。滚动重启使新 config + 新代码生效：

```bash
kubectl -n litellm rollout restart deployment/litellm
kubectl -n litellm rollout status deployment/litellm
```

## 验证

见 [04-verification-results.md](04-verification-results.md) 的验证命令；上线判定见
[03-rollout-and-rollback.md](03-rollout-and-rollback.md)。
