# 部署指南 — LiteLLM on EKS (CDK)

> **这是部署的总入口。** 从零部署到一个全新 AWS 账号,从头读到尾即可。
>
> 📌 **关于占位符(`<ACCOUNT_ID>` / `<HOSTED_ZONE_ID>` / `<your-domain>` 等)**:
> 主流程**无需手动替**它们。`./scripts/deploy.sh` 会用你**当前 AWS 凭证**自动拿 account,
> `init-env.ts` 会自动发现你账号里的 hosted zone / 可用 AZ / Postgres 版本 / Bedrock profiles
> 并写进 `cdk.context.json`。你**唯一要提供的是 `--domain` 和 `--region`**。文档里的 `<...>`
> 是给人读的示例值。**只有可选的 AgentCore websearch 特性**(见 §可选特性)需要你填自己的
> gateway 值——那是该特性预期的手动配置。
>
> 各步的**深入细节 / 排错**在专门文档里,本文会在对应位置给出链接:
> - [`docs/01-prerequisites-and-deploy.md`](docs/01-prerequisites-and-deploy.md) — 前置条件与参数发现的完整说明
> - [`docs/02-post-deploy-steps.md`](docs/02-post-deploy-steps.md) — 部署后手工步骤逐条(post 自动化失败时的备用)
> - [`docs/03-gotchas.md`](docs/03-gotchas.md) — 部署/销毁踩坑速查
>
> 部署分三段:**① 部署前准备 → ② 执行部署 → ③ 部署后收尾与验证**。

---

## 它会建出什么

三个 CloudFormation 栈,按依赖顺序部署(`Network → Data → Cluster`):

| 栈 | 内容 |
|---|---|
| `litellm-Network` | VPC、公私子网、NAT、安全组 |
| `litellm-Data` | RDS PostgreSQL、ElastiCache Redis、S3 日志桶、Secrets Manager(config/redis-auth)。**注意:SALT secret 不在此,需你手建,见 ①** |
| `litellm-Cluster` | EKS + Karpenter、IRSA、Helm(external-secrets / ALB controller / Karpenter)、Cognito、ACM、WAF、LiteLLM Deployment、Ingress、HPA/PDB,以及可选的 AgentCore websearch / 成本归因 |

模型默认走 **Bedrock Claude / Nova(经 IRSA,无需任何 AKSK/key)**。GPT-5.x、Gemini 是可选,见 [可选特性](#可选特性如需才看)。

> 💰 **部署前先估个价**:整套基础设施的月成本明细(EKS/RDS/Redis/节点/NAT/ALB 等,Price List 实价)见 [`docs/cost-analysis/README.md`](docs/cost-analysis/README.md)。模型调用费按 token 另算。

---

## ① 部署前准备

> 完整版见 [`docs/01-prerequisites-and-deploy.md` §0](docs/01-prerequisites-and-deploy.md)。这里是清单。

### A. 本地工具(部署机)

```bash
aws --version          # AWS CLI v2
node -v                # Node 18+
kubectl version --client
aws sts get-caller-identity   # 确认凭证有效、账号/身份正确
```
CDK 不用全局装,`npx cdk` 用仓库内置版本(`npm install` 后)。

### B. AWS 账号侧前置(部署前必须就绪)

| # | 前置 | 硬/软 | 怎么做 |
|---|------|-------|--------|
| B1 | **Route53 Hosted Zone** | 🔴 硬 | 域名的托管区必须先存在(ACM 验证 / Cognito 回调 / ALB alias 都依赖)。没有就 `aws route53 create-hosted-zone --name <your-domain> --caller-reference $(date +%s)`,再在域名注册商把 NS 指过来。init-env 会按层级匹配父区。 |
| B2 | **Bedrock 模型访问** | 🟡 软 | Console → Bedrock → Model access 勾选 Claude / Nova 申请。没开通的模型会被自动跳过,不致命。查:`aws bedrock list-inference-profiles --region <REGION>` |
| B3 | **部署者 IAM 权限** | 🔴 硬 | 最简单用 `AdministratorAccess`;受限角色需覆盖 ec2/eks/rds/elasticache/cognito/acm/wafv2/secretsmanager/iam(含 CreateRole/PassRole)/cloudformation/route53/s3 的全套。 |
| B4 | **CDK Bootstrap** | 🔴 硬·自动 | 每账号+区域首次需要,`deploy.sh deploy-all` 会自动跑,无需手动。 |
| B5 | **🔴🔴 SALT secret 手建** | 🔴 硬·**静默失败** | **最容易漏、漏了不报错**。见下方,**必须 deploy 前做**。 |

### B5 详解 — SALT secret(务必读)

`LITELLM_SALT_KEY` 对称加密 DB 里的虚拟 key。**一旦设定永不能改**(改了所有已存 key 解不开),所以 CDK **故意不创建**它(只 `fromSecretNameV2` 引用)。

- **漏建的后果(静默)**:`cdk synth`/`deploy` 不报错,但起 pod 时 ESO 同步 `salt.LITELLM_SALT_KEY` 失败 → litellm 起不来。
- **怎么建(首次 deploy 前,一次性)**:secret 名必须是 `<REGION>-litellm/salt`,JSON 键名 `LITELLM_SALT_KEY`:

```bash
SALT=$(openssl rand -hex 16)
aws secretsmanager create-secret \
  --name "<REGION>-litellm/salt" \
  --description "LiteLLM SALT key (encrypts DB-stored virtual keys; never rotate)" \
  --secret-string "{\"LITELLM_SALT_KEY\":\"$SALT\"}" \
  --region <REGION>
# ⚠️ 立即把 $SALT 备份到密码管理器 —— 丢了 = DB 里所有虚拟 key 报废,只能清库重建
```

> SALT **不是** `config` secret 里的字段,是独立的 `/salt` secret(代码读 `salt.LITELLM_SALT_KEY`)。

### C. 可选 provider key(只用 Claude/Nova 可全部跳过)

GPT-5.x 的 Mantle key、Gemini key 都是**部署后**才填的外部凭证,**不影响这一步**。要用再看 [可选特性](#可选特性如需才看)。

---

## ② 执行部署

### 一条命令全自动(推荐)

```bash
cd <repo>/cdk          # CDK 代码都在 cdk/ 子目录
npm install            # 首次

./scripts/deploy.sh deploy-all \
  --domain <your-domain> \
  --region <REGION> \
  --host-prefix litellm
```

顺序自动跑:`init`(参数自动发现)→ `bootstrap` → `deploy-network` → `deploy-data` → `deploy-cluster` → `post`(部署后自动化)。耗时约 **30–45 分钟**(EKS 控制面 + 节点最慢)。

`--host-prefix` 决定访问域名 = `<host-prefix>.<your-domain>`,默认 `litellm`。同一域名多区域部署用不同前缀避免 DNS 撞车。

### init-env 自动发现了什么(你不用手填)

`init` 调 AWS API 写出 `cdk.context.json`:account、有 Graviton 容量的可用 AZ、Route53 hostedZoneId、可用的最高 16.x Postgres 版本、Bedrock inference profiles、clusterAdminPrincipals(默认=当前调用者 ARN)。**唯一要你给的是 `--domain`**。

### 想分步、逐步检查?

```bash
./scripts/deploy.sh init --domain <your-domain> --region <REGION>
./scripts/deploy.sh bootstrap
./scripts/deploy.sh deploy-network
./scripts/deploy.sh deploy-data
./scripts/deploy.sh deploy-cluster
./scripts/deploy.sh post
```

> ⚠️ **要启用可选特性(AgentCore / 成本归因)**:`deploy.sh` 跑的 `npx cdk deploy` 只读 `cdk.context.json`,**不透传** feature flag。必须在 `init` 之后、`deploy-cluster` 之前,手动把 flag 加进 `cdk.context.json`(见 [可选特性](#可选特性如需才看))。

---

## ③ 部署后收尾与验证

> `deploy.sh post` 已**自动**做了下面 1–4 步。本节告诉你它做了什么 + 怎么验证。某步 `post` 打 WARN 跳过时,照 [`docs/02-post-deploy-steps.md`](docs/02-post-deploy-steps.md) 手工补。

| 步 | 内容 | post 自动? |
|---|------|:---:|
| 1 | Route53 A-alias `<host-prefix>.<your-domain>` → ALB | ✅ |
| 2 | 回填 Cognito client id/secret 进 config secret | ✅ |
| 3 | 建 Cognito admin 用户 + admin group(打印临时密码) | ✅ |
| 4 | rollout restart litellm + 验证非 CHANGE_ME | ✅ |
| 5 | 填 Mantle/Gemini key(**仅用 GPT/Gemini 时**) | ❌ 手工 |

### 更新 kubeconfig(跑任何 kubectl 前)

```bash
aws eks update-kubeconfig --name litellm-cluster --region <REGION>
```

### 验证清单

```bash
# 1. DNS 解析到 ALB
dig +short <host-prefix>.<your-domain>

# 2. 健康检查 200
curl -sk -o /dev/null -w "%{http_code}\n" https://<host-prefix>.<your-domain>/health/liveliness

# 3. pods 全 Ready(litellm 3/3,searxng 1/1)
kubectl get pods -n litellm

# 4. 用 master key 调一次模型
MK=$(aws secretsmanager get-secret-value --region <REGION> \
  --secret-id <REGION>-litellm/config --query SecretString --output text | jq -r '.LITELLM_MASTER_KEY')
curl -s https://<host-prefix>.<your-domain>/v1/chat/completions \
  -H "Authorization: Bearer $MK" \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"hi"}],"max_tokens":20}'

# 5. 浏览器登录 UI:https://<host-prefix>.<your-domain>/ui/  → Cognito SSO(用第 3 步的 admin 账号)
```

> 首次 UI 登录:用 post 打印的临时密码,系统强制改密。加进 admin group 后**要重新登录**才拿到带 group 的 token,否则看不到模型、不能建 key。

---

## 可选特性(如需才看)

这些默认**关闭**。启用方式:`init` 之后手动编辑 `cdk.context.json` 加对应 flag,再继续 `deploy-cluster`(或直接 `npx cdk deploy litellm-Cluster -c <flag>=...`)。

### AgentCore Web Search(替代内置 searxng)

- **开关**:`cdk.context.json` 加 `"websearchBackend": "agentcore"`(默认 `searxng`)。
- **限制**:AgentCore 仅 `us-east-1` 可用。
- **完整部署 + 客户端接入 runbook**:[`docs/11-optional-agentcore-websearch.md`](docs/11-optional-agentcore-websearch.md)。

### Bedrock 按团队成本归因

- **开关**:`cdk.context.json` 加 `"enableBedrockCostAttribution": "true"`。
- **效果**:建 `litellm-bedrock-exec` 角色 + 成本归因 hook,按 team 给 Bedrock 调用打 STS session tag,可在 Cost Explorer 按 `iamPrincipal/team` 拆账。
- **监控/对账细节**:[`docs/12-monitoring-logging.md`](docs/12-monitoring-logging.md) §⑤。

### GPT-5.x(Bedrock Mantle)/ Gemini

- 部署后填进 `<REGION>-litellm/config` secret 的 `BEDROCK_MANTLE_API_KEY` / `GEMINI_API_KEY` 字段,然后强制 ESO 同步 + rollout restart(见 [`docs/02-post-deploy-steps.md` §②](docs/02-post-deploy-steps.md))。
- **Mantle key 怎么拿**:Bedrock 控制台自助生成长期 key,见 [`docs/10-optional-gpt-mantle.md`](docs/10-optional-gpt-mantle.md)。

---

## 销毁

```bash
./scripts/deploy.sh destroy   # 逆序 Cluster → Data → Network
```

EKS + Karpenter 拆除有 finalizer 死锁、孤儿 instance profile、ALB 孤儿 SG 卡 VPC 等通病,且 RDS/S3/Cognito 有 RETAIN 残留需手清。**销毁前务必读** [`docs/03-gotchas.md`](docs/03-gotchas.md) 的销毁章节。
