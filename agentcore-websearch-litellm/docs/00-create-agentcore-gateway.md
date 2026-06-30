# 00 · 创建 AgentCore Web Search Gateway（服务端前置）

本篇是 [02 部署到 EKS](02-deploy-to-eks.md) 的**前置步骤**：02–06 都假设
「AgentCore Web Search Gateway 已存在」，本篇补上「这个 Gateway 怎么从零建出来」。

> 来源：本仓库根目录 `docs/agentcore-websearch-runbook.REAL.docx` 第 2 章（内部运维手册，
> 含真实值）。本篇保留真实 account / gateway id，供内部复现；对外公开版见 blog 的脱敏一节。

> **环境**：AWS 账号 `<ACCOUNT_ID>` · 区域 `us-east-1`（AgentCore 仅此区可用）。

---

## 2.0 前置条件（缺一不可）

| 条件 | 要求 | 检查命令 |
|---|---|---|
| AWS CLI | **≥ 2.35.7**（connector target 需要） | `aws --version` |
| Python | 3.10+ | `python3 --version` |
| 区域 | 必须 us-east-1 | — |
| IAM 权限 | 建 role/gateway/target + 调用 | 见下 |

⚠️ **CLI 版本是最大坑**：低于 2.35.7 会报
`Unknown parameter ... must be one of: openApiSchema,smithyModel,lambda,mcpServer,apiGateway`
（缺 connector）。`bedrock-agentcore-control` 的 API 模型只随 **aws-cli v2** 分发，pip 装的
boto3（即便很新）也没有该模型。

升级 aws-cli（官方 pkg 方式）：

```bash
curl -s "https://awscli.amazonaws.com/AWSCLIV2.pkg" -o /tmp/AWSCLIV2.pkg
sudo installer -pkg /tmp/AWSCLIV2.pkg -target /
aws --version   # 确认 ≥ 2.35.7
```

权限自检（应全部 allowed）：

```bash
aws iam simulate-principal-policy \
  --policy-source-arn "arn:aws:iam::<ACCOUNT_ID>:user/bedrock-admin" \
  --action-names "iam:CreateRole" "iam:PutRolePolicy" \
    "bedrock-agentcore:CreateGateway" "bedrock-agentcore:CreateGatewayTarget" \
    "bedrock-agentcore:InvokeGateway" "bedrock-agentcore:InvokeWebSearch" \
  --query 'EvaluationResults[].{Action:EvalActionName,Decision:EvalDecision}' --output table
```

---

## 2.1 建 Gateway 服务角色

Gateway 由这个角色 assume，用来调 Web Search。

```bash
# 建角色（信任 bedrock-agentcore 服务）
aws iam create-role --role-name AgentCoreWebSearchGatewayRole \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"bedrock-agentcore.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

# 附权限：InvokeGateway + InvokeWebSearch
aws iam put-role-policy --role-name AgentCoreWebSearchGatewayRole \
  --policy-name WebSearchPerms \
  --policy-document '{"Version":"2012-10-17","Statement":[
    {"Effect":"Allow","Action":"bedrock-agentcore:InvokeGateway",
     "Resource":"arn:aws:bedrock-agentcore:us-east-1:<ACCOUNT_ID>:gateway/*"},
    {"Effect":"Allow","Action":"bedrock-agentcore:InvokeWebSearch",
     "Resource":"arn:aws:bedrock-agentcore:us-east-1:aws:tool/web-search.v1"}]}'
```

---

## 2.2 建 Gateway（关键：`--authorizer-type AWS_IAM`）

```bash
aws bedrock-agentcore-control create-gateway \
  --name websearch-gw \
  --role-arn "arn:aws:iam::<ACCOUNT_ID>:role/AgentCoreWebSearchGatewayRole" \
  --protocol-type MCP \
  --authorizer-type AWS_IAM \
  --region us-east-1
# 返回 gatewayId / gatewayUrl，等 status=READY
```

选 `AWS_IAM` 而非 `CUSTOM_JWT`：省掉自建 IdP（Cognito）和 token 刷新，用 AWS 凭证直接签名。

> **本次部署结果**：gatewayId `<AGENTCORE_GATEWAY_ID>`，URL
> `https://<AGENTCORE_GATEWAY_ID>.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp`

等 READY：

```bash
aws bedrock-agentcore-control get-gateway --region us-east-1 \
  --gateway-identifier <AGENTCORE_GATEWAY_ID> --query 'status' --output text
```

---

## 2.3 加 Web Search connector target

```bash
aws bedrock-agentcore-control create-gateway-target \
  --gateway-identifier <AGENTCORE_GATEWAY_ID> \
  --name web-search-tool \
  --target-configuration '{"mcp":{"connector":{"source":{"connectorId":"web-search"},
    "configurations":[{"name":"WebSearch","parameterValues":{}}]}}}' \
  --credential-provider-configurations '[{"credentialProviderType":"GATEWAY_IAM_ROLE"}]' \
  --region us-east-1
```

ℹ️ target 名 `web-search-tool` + 工具名 `WebSearch` → 实际工具全名
`web-search-tool___WebSearch`（三下划线），这正是 [02](02-deploy-to-eks.md) /
[05 bug #2](05-issues-and-gotchas.md) 里用的名字。换名字时这里改。

（可选）域名黑名单——禁止搜索特定站点，服务端强制、对模型隐藏：在 `parameterValues` 内加
`"domainFilter":{"exclude":["blocked-1.com","blocked-2.com"]}`。

---

## 2.4 给「调用方」加权限

谁调用这个 Gateway，就给谁 `InvokeGateway`。本方案里**调用方是 LiteLLM Pod 的 IRSA role**
（见 [02 第 3 节](02-deploy-to-eks.md)）；若是本机客户端直连，则给本机 IAM 身份：

```bash
# 例：给本机 user 加（客户端直连场景）
aws iam put-user-policy --user-name bedrock-admin \
  --policy-name InvokeWebSearchGW \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow",
    "Action":"bedrock-agentcore:InvokeGateway",
    "Resource":"arn:aws:bedrock-agentcore:us-east-1:<ACCOUNT_ID>:gateway/<AGENTCORE_GATEWAY_ID>"}]}'
```

---

## 2.5 服务端踩坑清单

| 坑 | 现象 | 解 |
|---|---|---|
| CLI 版本 | `Unknown parameter ... connector` | 升级 aws-cli ≥ 2.35.7 |
| `--service` 错 | 403 签名失败 | 调用方 `--service` 必须 `bedrock-agentcore` |
| 区域 | 找不到工具 | 只 us-east-1 |
| `--read-only` | 连上了但工具列表为空 | **别加**——WebSearch 无 readOnlyHint，会被过滤器误删 |

---

建好 Gateway 后，回到 [02 部署到 EKS](02-deploy-to-eks.md) 把它接进 LiteLLM interception，
或 [06 暴露成 MCP server](06-expose-as-mcp-server.md) 给客户端用。
