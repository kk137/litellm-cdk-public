# 06 · 把 AgentCore Web Search 当 MCP Server 暴露给客户端

本篇是 [02 的 interception 做法](02-deploy-to-eks.md) 的**另一种用法**，二者互补、可并存。

## 这是什么 / 解决什么

interception(02–05)解决的是「**Claude 发普通请求 → 网关自动补搜索、客户端零改动**」——
代价是那一轮必须**非流式**(见 [01](01-background-and-decision.md) 及 interception 机制)。

本篇解决的是另一个诉求:

> **无 AWS 凭证的客户端**(如 Codex、其它团队/CI),想自己挂 AgentCore Web Search 当 MCP
> 工具用,但**不愿在每台客户端放 AWS AK/SK**。

做法:让**已有的 LiteLLM 网关**把 AgentCore Web Search 注册成一个**后端 MCP server**,
对外用 **LiteLLM virtual key** 鉴权,对内用 **pod 的 IRSA** 做 SigV4 签名。

```
无凭证客户端 (Codex / CI)
   │  x-litellm-api-key: Bearer sk-<virtual key>     ← 复用现有 virtual key,无 AWS 凭证
   ▼
LiteLLM 网关  /mcp/   (已有, 持 IRSA)
   │  注册的 MCP server: auth_type=aws_sigv4
   │  用 pod IRSA → SigV4 → us-east-1                 ← 凭证集中在网关
   ▼
AgentCore Web Search MCP  (同 02 的同一个 gateway / 同一个 InvokeGateway 权限)
```

**不需要新建 EC2 代理,不需要改 LiteLLM 源码**——LiteLLM 原生支持 `aws_sigv4` 后端
(UI 里该选项标签原文就是 "AWS SigV4 (Bedrock AgentCore MCPs)")。

## 与 interception 的关系(两条独立路径,可并存)

| | interception(02–05) | MCP server(本篇) |
|---|---|---|
| 触发 | 客户端发普通请求,网关自动拦 | 客户端**主动**把它挂成 MCP 工具 |
| 客户端改动 | 零 | 要配 MCP server(给个 URL+key) |
| 流式 | ❌ 强制非流式 | 由客户端 MCP 调用决定,不受 interception 约束 |
| 实现 | callback(`agentcore_websearch.py`) | LiteLLM 内置 MCP gateway + `aws_sigv4` |
| 后端 | **同一个** AgentCore gateway / 同一个 IRSA `InvokeGateway` 权限 | 同左 |

二者共用同一个 AgentCore gateway 和同一条 IAM 权限,互不冲突(一个是 callback,一个是
MCP server 注册)。

## 关键机制(源码确认)

- **凭证走 IRSA、不填 ak/sk**:`MCPSigV4Auth`(`litellm/experimental_mcp_client/client.py`)
  在未提供 `aws_access_key_id`/`aws_secret_access_key` 时,**回落 botocore 默认凭证链**
  (`botocore.session.get_session().get_credentials()`),该链含 EKS 注入的 web-identity
  provider(`AWS_WEB_IDENTITY_TOKEN_FILE` + `AWS_ROLE_ARN`)→ IRSA 自动生效。
- **`aws_role_name` 可省**:设了才会在基础凭证之上**再做一次 `sts:AssumeRole`**(二跳)。
  我们的 IRSA role 本身已有 `InvokeGateway` 权限 → **不填**。
- **默认值正好匹配**:`aws_service_name` 默认 `bedrock-agentcore`、`aws_region_name`
  默认 `us-east-1`。
- **访问控制按 key/team 生效**:`get_allowed_mcp_servers()` 按 key/team 的
  `object_permission.mcp_servers` / `mcp_access_groups` 求交集授权;**除非** server 开了
  `allow_all_keys`(那样任何 key 都能用 → 会白烧钱)。

### ⚠️ 关键认知:IP 过滤 ≠ key 授权(实操踩坑)

LiteLLM 对 MCP server 有**两套互相独立**的访问控制,别混为一谈:

| 机制 | 控制维度 | UI 开关 | 干什么 |
|---|---|---|---|
| **key 授权** | virtual key | `allow_all_keys` + `mcp_access_groups` | **「限定谁能用 + 省钱」靠这个** |
| **IP 过滤** | 来源 IP | `available_on_public_internet`(UI 叫 "Internal network only") | 按调用方 IP 放行/拒绝,与 key 无关 |

实操踩坑:一度把 "Internal network only" 打开想「收紧」,结果 UI 的工具测试器立刻报
**`403 ip_filtering: not accessible from your IP (54.240.199.100) … restricted to internal
networks only`**。原因:我们是**公网 ALB + 公网客户端**,打开 Internal only 会按 IP 把公网
来源全挡掉。

→ 正确做法:**公网客户端场景下 `available_on_public_internet` 必须保持 `true`(Internal
only 关)**;省钱/限流**完全靠 access group + key 授权**,不靠 IP 过滤。只有当所有客户端都在
VPC/内网内访问时,才该开 Internal only。

---

## WebUI 配置步骤

### 第 1 步 · 添加 MCP Server

左侧导航 **AI GATEWAY → MCP Servers**(`/ui/?page=mcp-servers`)→ **Add New MCP Server**:

| 字段 | 值 |
|---|---|
| MCP Server Name | `agentcore_websearch` |
| Transport Type | **Streamable HTTP (Recommended)**(即 `http`) |
| MCP Server URL | `https://<AGENTCORE_GATEWAY_ID>.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp` |
| **Auth Type** | **AWS SigV4 (Bedrock AgentCore MCPs)** |

选完 Auth Type 后出现 AWS 字段,**只填 Region**,其余留空:

| 字段 | 填什么 | 说明 |
|---|---|---|
| AWS Region | `us-east-1` | 必填 |
| AWS Service Name | 留空 | 默认 `bedrock-agentcore` |
| AWS Access Key ID / Secret | **留空** | 走 pod IRSA |
| AWS Role ARN / Session Name | **留空** | IRSA role 已有 InvokeGateway 权限,无需二跳 AssumeRole |

展开 **Permission Management / Access Control**(添加后也可在 server 详情页
**Settings → Edit Settings** 里改),设三项:

| 字段 | 设成 | 为什么 |
|---|---|---|
| **MCP Access Groups** | 输入 `paid_search`(`mode=tags`,直接打字创建) | 圈定谁能用 |
| **Allow All LiteLLM Keys** | **关** | 否则任何 key 都能用 → 白烧钱 |
| **Internal network only** | **关**(= Network Access 保持 Public) | 公网 ALB + 公网客户端,开了会按 IP 把客户端挡掉(见上「IP 过滤 ≠ key 授权」) |

保存。

### 第 2 步 · 授权给特定 key

左侧 **Keys → Create Key**(或编辑已有 key)→ 在 **MCP Access Groups** 下拉勾选
`paid_search` → 生成。只有带这个组的 key 才能调 AgentCore Web Search。

### 第 3 步 · 客户端连接(无 AWS 凭证)

客户端的 MCP 配置指向 LiteLLM MCP 端点,鉴权头二选一(值为 `sk-` virtual key,可带 `Bearer`):

```
x-litellm-api-key: Bearer sk-<virtual-key>
```
或
```
Authorization: Bearer sk-<virtual-key>
```

可选发 `x-mcp-servers: agentcore_websearch` 只挂这一个 server。客户端全程无需 AWS 凭证。

> ⚠️ **客户端 URL 必须带 `/mcp/` 路径**(踩过):LiteLLM 的 MCP 端点在 `/mcp/`,不是根域名。
> 填 `https://litellm-sg.<your-domain>`(缺路径)连不上,要写
> `https://litellm-sg.<your-domain>/mcp/`。

---

## 等价 config.yaml(若走 CDK 回写而非点 UI)

```yaml
mcp_servers:
  agentcore_websearch:
    url: "https://<AGENTCORE_GATEWAY_ID>.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp"
    transport: "http"
    auth_type: "aws_sigv4"
    aws_region_name: "us-east-1"
    # aws_service_name: 默认 bedrock-agentcore,可省
    # 不填 ak/sk → 走 pod IRSA 默认链
    # 不填 aws_role_name → 不做二跳 AssumeRole
    access_groups: ["paid_search"]
    # 切勿设 allow_all_keys: true
```

> ⚠️ UI 添加 = 写 DB;config.yaml 添加 = 走 CDK。两者都生效但**别两边各配一份**造成困惑。
> 选一种作为真源。当前生产 interception 是 ConfigMap/CDK 真源,若这个 MCP server 也要持久化
> 优先走 CDK 回写(同 [05 note #6](05-issues-and-gotchas.md) 的回写纪律)。

---

## 上线前核对(机制已确认,环境需对一遍)

1. **IRSA 权限复用**:本篇与 interception 用**同一个** AgentCore gateway,复用现有
   inline policy `InvokeAgentCoreWebSearchGW`(仅 `InvokeGateway`)——**不需额外加权限**。
2. **`allow_all_keys` 必须关;`available_on_public_internet` 按客户端网络定**:
   - `allow_all_keys=false`(开了任何 key 都能用 → $7/1000 失控)。
   - `available_on_public_internet`:**公网客户端保持 `true`**(否则按 IP 挡掉,报
     `403 ip_filtering`)。限流靠 access group + key 授权,**不靠** IP(见上「IP 过滤 ≠
     key 授权」)。
3. **真实工具名**:连上后用 MCP `tools/list` 确认工具名仍是
   `web-search-tool___WebSearch`(见 [05 bug #2](05-issues-and-gotchas.md))。
4. **后端可观测性**:调用会经过同一个 gateway,Metrics(`AWS/Bedrock-AgentCore`)与
   vended Logs 同 [05 issue #4/#5](05-issues-and-gotchas.md) 一并可查,无需额外配置。

---

## 用管理 API 核对配置(pod 内,不外暴露)

UI 操作写的是 DB,可用管理 API 复核 server 与 key 是否真的闭环:

```bash
MK=$(kubectl -n litellm get secret litellm-secrets -o jsonpath='{.data.LITELLM_MASTER_KEY}' | base64 -d)
POD=$(kubectl -n litellm get pod -l app=litellm -o name | head -1 | cut -d/ -f2)

# server 侧:确认 auth_type / allow_all_keys / public_internet / mcp_access_groups / allowed_tools
kubectl -n litellm exec $POD -- python3 -c "
import urllib.request, json
req=urllib.request.Request('http://localhost:4000/v1/mcp/server', headers={'Authorization':'Bearer $MK'})
[print(s['server_name'], s['auth_type'], 'allow_all=',s['allow_all_keys'],
       'public=',s['available_on_public_internet'], 'groups=',s['mcp_access_groups'],
       s['allowed_tools']) for s in json.loads(urllib.request.urlopen(req).read())]"

# key 侧:确认目标 key 的 object_permission.mcp_access_groups 含该组
kubectl -n litellm exec $POD -- python3 -c "
import urllib.request, json
req=urllib.request.Request('http://localhost:4000/key/list?return_full_object=true&size=100', headers={'Authorization':'Bearer $MK'})
for k in json.loads(urllib.request.urlopen(req).read())['keys']:
    op=k.get('object_permission') or {}
    print(k.get('key_alias'), 'mcp_groups=', op.get('mcp_access_groups'))"
```

## 状态

✅ **已在新加坡生产配置并核对(2026-06-22)**。`litellm-cluster` @ ap-southeast-1:

| 项 | 实测值 |
|---|---|
| server | `agentcore_websearch`(id `a251e3f8-1d09-4708-a5d3-8d064def4822`) |
| auth_type | `aws_sigv4`(credentials 空 → 走 pod IRSA) |
| allow_all_keys | `false` ✅ |
| available_on_public_internet | `true`(公网客户端需要,见上) |
| mcp_access_groups | `['paid_search']` ✅ |
| 授权 key | `TeamF-test01`,`object_permission.mcp_access_groups=['paid_search']` ✅ 闭环 |
| allowed_tools | `web-search-tool___WebSearch` ✅ |

LiteLLM `aws_sigv4` MCP 后端支持已从源码确认(`MCPAuth.aws_sigv4`、`MCPSigV4Auth` IRSA 回落、
按 key/team 的 `object_permission` 访问控制)。当前为 UI/DB 配置,**尚未回写 CDK**——
`cdk deploy` 不会动 DB 里的 MCP server,但若要纳入 IaC 真源需按上方 config.yaml 片段回写
(同 [05 note #6](05-issues-and-gotchas.md) 回写纪律)。

> 客户端侧:URL 须为 `.../mcp/`,Bearer 用 `TeamF-test01` 的明文 key。端到端验证(发起搜索 →
> 网关日志确认 SigV4 调通)待客户端实测。
