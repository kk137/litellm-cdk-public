# LiteLLM on EKS — CDK 全栈复现

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CDK](https://img.shields.io/badge/IaC-AWS%20CDK%20(TypeScript)-orange.svg)](https://aws.amazon.com/cdk/)
[![EKS](https://img.shields.io/badge/EKS-1.35-blue.svg)](https://aws.amazon.com/eks/)

一套参数驱动、一条命令拉起的 CDK(TypeScript),从零复现生产级 LiteLLM-on-EKS 架构——
换账号/换区域部署**只需要一个域名 + 一个 region**:
VPC → EKS → Karpenter → RDS / Redis / S3 → Cognito SSO → ACM → WAF → LiteLLM + searxng。

这是一份经过真实部署验证的 IaC 沉淀:`scripts/init-env.ts` 自动发现所有账号相关参数
(账号、有 NodePool 容量的 AZ、hosted zone、RDS 版本、Bedrock 模型可用性),litellm
的模型配置在 synth 时按 region 动态生成。一条 `./scripts/deploy.sh` 端到端拉起三个栈。

## 选型原则

本复现遵循几条刻意的设计原则——可按你的环境调整:

1. **参数驱动,零硬编码。** 账号/region 来自 AWS 环境;域名/zone/AZ/RDS 版本/Bedrock
   profiles 由 `init-env.ts` 自动发现。源码零真实值(每次 push 前 grep 校验)。
2. **最小权限。** Bedrock IRSA 只授 `foundation-model/*` + `inference-profile/*`(不是 `*`);
   RDS/Redis 安全组 `allowAllOutbound: false`。
3. **密钥不落盘。** 凭证只存 AWS Secrets Manager,经 External Secrets Operator(ESO)
   同步进 pod——不进代码、不进 ConfigMap、不进 values 文件。
4. **拓扑忠实生产。** 3 副本、maxSurge 0、taint 排除式调度,HPA/PDB 和 NodePool 都
   对齐真实集群而非教科书默认值。
5. **镜像钉版本。** searxng 和 litellm-database 镜像都钉到确切 tag,绝不用 `:latest`。

## 架构全景

```
                          Route53  litellm.<DOMAIN>  (A-alias, post-deploy)
                              │
                              ▼
                  WAFv2 litellm-waf  (rate-limit/IP block; managed groups Count)
                              │
                              ▼
                   internet-facing ALB  (ACM *.<DOMAIN>, idle 1200s)
                              │   ⟵ Cognito UserPool/Client/Domain (UI SSO)
                              ▼
        ┌──────────────  EKS 1.35  (namespace: litellm)  ──────────────┐
        │  LiteLLM Pod × 3  (Karpenter arm64 r6g/r7g; SA litellm-sa)    │
        │     ├──→ AWS Bedrock        (Claude / Nova, via IRSA — no AKSK)│
        │     ├──→ Bedrock Mantle     (GPT-5.x / Grok, openai provider)  │
        │     ├──→ Gemini API                                            │
        │     ├──→ searxng            (web-search interception)          │
        │     ├──→ RDS PostgreSQL     (spend / usage tracking)           │
        │     ├──→ ElastiCache Redis  (TLS + AUTH; routing/rate state)   │
        │     └──→ S3 logs bucket     (s3_v2 request-log callback)       │
        │  controllers on tainted system MNG: ESO / aws-lbc / karpenter  │
        └───────────────────────────────────────────────────────────────┘
       Secrets Manager:  <region>-litellm/config  ·  rds-master  ·  redis-auth
       └─ synced into the pod by ESO (ClusterSecretStore + ExternalSecret)
```

## 仓库结构地图

> 🚀 **要部署?直接看 [`DEPLOYMENT.md`](DEPLOYMENT.md)** —— 部署总入口,从头读到尾即可。
>
> 📌 文档里的 `<ACCOUNT_ID>` / `<HOSTED_ZONE_ID>` 等占位符**主流程无需手动替** —— `deploy.sh` + `init-env.ts` 会用你自己的 AWS 凭证自动发现并写进 `cdk.context.json`,你只需给 `--domain` / `--region`。详见 DEPLOYMENT.md 顶部说明。

**顶层布局:**

| 路径 | 是什么 |
|---|---|
| `DEPLOYMENT.md` | 部署总入口(前置 / 部署 / 后置三段) |
| `cdk/` | **全部 CDK 代码**:`bin/`(应用入口)、`lib/`(三个栈 + helpers/policies)、`scripts/`(`deploy.sh` 一键部署、`init-env.ts` 参数自动发现)、`cdk.json` / `package.json` / `tsconfig.json` 等配置。**部署命令都在这个目录里跑** |
| `docs/` | 编号文档,见下表(文件名即阅读顺序) |
| `agentcore-websearch-litellm/` | **可选附属服务**:AgentCore Web Search × LiteLLM 集成(独立 Python 子项目,自带 docs) |
| `bedrock-cost-attribution/` | **可选附属服务**:per-team Bedrock 成本归因 hook(Python) |

**`docs/` 编号文档(01–03 主线必读 · 10–12 可选特性):**

| 文件 | 内容 |
|---|---|
| [`01-prerequisites-and-deploy.md`](docs/01-prerequisites-and-deploy.md) | 前置条件 + 参数自动发现 + 一键部署(深入版) |
| [`02-post-deploy-steps.md`](docs/02-post-deploy-steps.md) | 部署后手工步骤逐条(post 自动化失败时备用) |
| [`03-gotchas.md`](docs/03-gotchas.md) | 部署 / 销毁踩坑速查 |
| [`10-optional-gpt-mantle.md`](docs/10-optional-gpt-mantle.md) | GPT-5.x via Bedrock Mantle:API key 生成 + 接入 |
| [`11-optional-agentcore-websearch.md`](docs/11-optional-agentcore-websearch.md) | AgentCore Web Search 部署 + 客户端接入 runbook |
| [`12-monitoring-logging.md`](docs/12-monitoring-logging.md) | SpendLogs / Prometheus / CloudWatch / S3 + 成本归因 |
| [`cost-analysis/README.md`](docs/cost-analysis/README.md) | **部署前先看**:整套基础设施月成本明细(Price List 实价,不含模型调用费) |

---

## 内容地图

> 下表是本 README 自身的章节导航。要**部署**请从 [`DEPLOYMENT.md`](DEPLOYMENT.md) 开始,本 README 只讲"是什么/为什么"。

| # | 章节 | 内容 |
|---|---|---|
| 1 | [三栈资源清单](#三栈资源清单) | Network / Data / Cluster 各建什么 |
| 2 | [节点架构](#节点架构pod-落在哪) | 系统 MNG + Karpenter 混合布局、pod 落点 |
| 3 | [扩容上限](#扩容上限一个已知的名义差) | HPA maxReplicas 名义上限与实际容量 |
| 4 | [参数化](#参数化真实值不进-git) | 真实值如何经 context 注入(零硬编码) |
| 5 | [换区部署](docs/01-prerequisites-and-deploy.md) | 一键换区 + 自动发现 + 部署后步骤 + 排错 |
| 6 | [本地构建 / synth / dry-run](#本地构建--synth--dry-run) | 本地构建、synth、cdk diff |
| 7 | [部署必做事项](#部署前后必做的事唯一出处在-deploymentmd) | 指向 DEPLOYMENT.md + SALT 警告 |
| 8 | [模型配置与认证模型](#模型配置与认证模型对齐生产) | 模型表生成、IRSA/openai provider、超时 |
| 9 | [安全姿态](#安全姿态刻意的取舍) | WAF Count-only / EKS 端点 / IRSA scope |
| 10 | [已知差距](#与真实生产环境的已知差距) | 与真实生产的已知差距 |

## 三栈资源清单

| 栈 | 资源 |
|---|---|
| **litellm-Network** | VPC(10.0.0.0/16,2 AZ,1 NAT)+ EKS/Karpenter 子网发现 tag + 共享节点安全组 |
| **litellm-Data** | RDS Postgres(Multi-AZ)+ ElastiCache Redis(7.1,Multi-AZ,**传输加密 + AUTH**)+ S3 日志桶 + Secrets Manager(3 个 secret:`<region>-litellm/config`、RDS 托管 master、`<region>-litellm/redis-auth`) |
| **litellm-Cluster** | EKS 1.35 + OIDC + IRSA(Karpenter/ALB-controller/ESO + **litellm-sa** 的 Bedrock/S3)+ Helm(external-secrets、aws-lbc、karpenter)+ **Cognito**(UserPool/Client/Domain,UI SSO)+ **ACM** `*.<domain>` + **WAFv2** `litellm-waf` + k8s manifests(ns、ESO store/ExternalSecret、ConfigMap、Deployment ×3、Service、internet-facing Ingress、HPA `litellm-hpa`、PDB `litellm-pdb`、EC2NodeClass、NodePool `litellm-nodepool` arm64 r6g/r7g、**searxng**) |

内置拓扑:3 副本、maxSurge 0 / maxUnavailable 1、request 2cpu/4Gi limit 4cpu/8Gi、
`--num_workers 2`、config 挂载于 `/app/config/config.yaml`、HPA min3/max20 cpu65%/mem80%、
NodePool arm64 r6g/r7g .xlarge/.2xlarge。

## 节点架构(pod 落在哪)

这是**混合**布局(不是纯 Karpenter):一小组固定的托管节点组跑控制器,应用容量全部由
Karpenter 动态供给。

| 节点组 | 是什么 | 谁跑在上面 | 门禁 |
|---|---|---|---|
| **系统 MNG** | EKS 托管节点组,`t3.medium × 2`,带 `CriticalAddonsOnly=true:NoSchedule` taint | 只有控制器:external-secrets、aws-lbc、karpenter、metrics-server——各自带匹配的 **toleration** | taint 挡住一切没有 toleration 的 pod |
| **Karpenter 节点** | 由 NodePool `litellm-nodepool` 动态供给(arm64 r6g/r7g) | litellm pods(+ searxng) | — |

`defaultCapacity: 0`,常驻节点**只有** 2 台系统 `t3.medium`;应用容量全部按需由 Karpenter 拉起。

**litellm 如何被挡在系统节点之外——靠排除,不靠白名单。**
litellm Deployment **没有 `CriticalAddonsOnly` toleration、也没有 `nodeSelector`**
(对齐生产的空 nodeSelector)。系统 MNG 带 taint 而 litellm 无法容忍,调度器剩下的唯一
候选就是无 taint 的 Karpenter 节点。(常见的替代做法是显式
`nodeSelector: provisioned-by=karpenter` 白名单;这里用 taint 排除式以对齐生产。)

> 对 `topologySpreadConstraints` 的影响:`DoNotSchedule` / `ScheduleAnyway` 只决定
> litellm 在 **Karpenter 节点之间**怎么摊开——它永远不会让 pod 落到系统节点(那道门
> 是 taint,不是拓扑)。当前 hostname 约束(`maxSkew:1` + `DoNotSchedule`)意味着
> **一节点一 litellm pod**;放宽为 `ScheduleAnyway` 可以一节点多 pod,但仍然只在
> Karpenter 池内。

### 扩容上限(一个已知的名义差)

`HPA maxReplicas: 20` 是当前 NodePool 实际够不着的名义上限:`limits.cpu: 32` ÷ 每 pod
2 cpu ≈ 16 pod,而"一节点一 pod"进一步压到 4(r*.2xlarge,8 vCPU)– 8(r*.xlarge,
4 vCPU)。这与生产一致(生产同样 `limits.cpu 32` + `DoNotSchedule`,实际稳态 3 pod /
3 node,从未接近 20)。想让 20 真正可达:把 `limits.cpu` 提到 ≥48 并把 hostname 约束放宽为
`ScheduleAnyway`;这里保持原样以忠实生产。

## 参数化(真实值不进 git)

经 `-c` 或本地 `cdk.context.json` 传入(gitignored——从 `cdk.context.example.json` 复制):

| Context key | 含义 | 示例 |
|---|---|---|
| `domain` | 基础域名;ingress host = `litellm.<domain>`,证书 = `*.<domain>` | `your-domain.example.com` |
| `hostedZoneId` | `<domain>` 的 Route53 hosted zone id(本账号内) | `Z0xxxxxxxxxxxxx` |
| `clusterAdminPrincipals` | 授予 EKS cluster-admin 的 IAM ARN(不给会丢 kubectl) | `["arn:aws:iam::<acct>:role/Admin"]` |

账号/region 来自 `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`(绝不硬编码)。

## 换区部署(参数驱动)

一条命令——`scripts/init-env.ts` 自动发现账号、AZ(带 NodePool 容量过滤)、hosted
zone、**RDS Postgres 版本**、Bedrock 模型可用性;必填只有 `--domain`。完整流程 +
部署后步骤 + 排错:**[docs/01-prerequisites-and-deploy.md](docs/01-prerequisites-and-deploy.md)**。

```bash
cd cdk   # 全部 CDK 代码都在 cdk/ 下
./scripts/deploy.sh deploy-all --domain your.domain.com --region ap-southeast-1 --host-prefix litellm-sin
# 或: make init DOMAIN=... REGION=... HOST_PREFIX=... [MAX_AZS=2]   (之后 synth/deploy)
```

## 本地构建 / synth / dry-run

```bash
cd cdk          # 全部 CDK 代码都在 cdk/ 下
npm install
npx tsc --noEmit
# 先自动发现参数,再 synth/diff(CDK 读 cdk.context.json)
make init DOMAIN=<domain> REGION=<region>
npx cdk synth
npx cdk diff   # 对 AWS 做 dry-run(需要凭证 + bootstrap;不部署任何东西)
```

手动兜底(跳过 init-env,全部手传):
```bash
CDK_DEFAULT_ACCOUNT=<acct> CDK_DEFAULT_REGION=<region> \
  npx cdk synth -c domain=<domain> -c hostedZoneId=<zoneId> -c clusterAdminPrincipals='["arn:..."]'
```

## 部署前后必做的事(唯一出处在 DEPLOYMENT.md)

操作步骤**只维护在 [`DEPLOYMENT.md`](DEPLOYMENT.md) 一处**(前置清单 → 一键部署 → 部署后收尾),本 README 不重复,以免多处副本失同步。仅提示其中唯一"漏了不报错、pod 静默起不来"的一项:

> ⚠️ **SALT secret 必须在首次 deploy 前手建**,且是**独立 secret** `<region>-litellm/salt`(**不是** config secret 里的字段)。一旦设定永不能改。详见 [`DEPLOYMENT.md` §B5](DEPLOYMENT.md) 与 [`docs/03-gotchas.md` #8](docs/03-gotchas.md)。

其余(Cognito 回填、Route53 alias、admin 用户、rollout 验证)由 `./scripts/deploy.sh post` 幂等自动完成;searxng 的 `settings.yml` 已完整内置于 CDK,无需手工注入。

## 模型配置与认证模型(对齐生产)

litellm 的 configmap 由 `lib/helpers/model-config-builder.ts` **在 synth 时动态生成**
(没有静态 YAML)——按 init-env 发现的 profiles 为每个 region 选对 Bedrock
inference-profile 前缀(`us./global./apac.`),并自动丢弃该 region 不提供的模型。
下面是全部 profile 可用时 builder 输出的模型集:

- **Bedrock Claude / Nova** 走 **IRSA** 认证——litellm pod 以 SA `litellm-sa` 运行
  (`ClusterStack` 创建),其 IAM 角色有 `bedrock:InvokeModel*` / `bedrock:Converse*`。
  config 里没有任何 AKSK,条目只带 `aws_region_name`。
- **GPT-5.x / Grok**(Bedrock Mantle)用 `openai/` provider + `BEDROCK_MANTLE_API_KEY`
  指向 `/openai/v1` base(litellm 会拼 `/responses` → 实际调 `/v1/responses`)。
- **Gemini** 用 `GEMINI_API_KEY`。
- 完整模型集:`claude-fable-5`(+`[1m]`)、opus-4-8/4-7/4-6、**sonnet-5**(2026-06-30 GA,
  带促销期定价)、sonnet-4-6(+`[1m]`)、haiku-4-5、nova-{premier,pro,lite,micro}、
  gemini-3.5-flash/3.1-flash-image、gpt-5.5/5.4(+ Oregon 兜底)、grok-4.3,以及 Codex
  守护别名(`codex-auto-review` / `gpt-5.4-mini` / `gpt-5` / `gpt-5-codex`)。
- **WebSearch 拦截** + `searxng-search` 搜索工具 + **`s3_v2`** 请求日志 callback 均已
  接好(S3 桶名在 synth 时从 `DataStack` 注入)。
- `router_settings.timeout: 1200` 与 ALB idle 超时对齐。
- 镜像钉在 `ghcr.io/berriai/litellm-database:v1.84.3`(可用 `-c litellmImage=...` 或
  `cdk.json` 覆盖)。

## 安全姿态(刻意的取舍)

以下有意对齐真实生产——按你的环境需要自行收紧:

- **WAF 托管规则组只 Count 不 Block。** `CommonRuleSet` 和 `KnownBadInputs` 都跑在
  `overrideAction: count`(只观察不拦截),与线上 WAF 一致;**只有按 IP 限速规则
  (priority 3)真正 Block**。真正的防线是 API-key / master-key 认证。要真拦截,把对应
  规则组的 `overrideAction` 改成 `none`。
- **EKS API 端点是 `PUBLIC_AND_PRIVATE`**,方便笔记本直接 kubectl(验证便利)。生产
  建议用 `publicAccessCidrs` 收紧。
- **Bedrock IRSA** 只授 `foundation-model/*` + `inference-profile/*`(不是 `*`)。

## 与真实生产环境的已知差距

- 从零建**全新**栈——**不接管**已存在的集群。

## 贡献

欢迎 Issue / PR——尤其是:

- 新的 Bedrock region 支持(更多 inference-profile 前缀)
- 减少部署后手工步骤(例如用 external-dns 接管 Route53 alias)
- 给 model-config builder 和 NodePool zones 补 CDK assertion 测试
- 其他踩坑与修复(已知的见 [docs/01-prerequisites-and-deploy.md](docs/01-prerequisites-and-deploy.md))

## License

MIT © 2026 — 见 [LICENSE](LICENSE)。

## 致谢

- [LiteLLM](https://github.com/BerriAI/litellm) by BerriAI
- [External Secrets Operator](https://external-secrets.io/) · [Karpenter](https://karpenter.sh/) · [AWS Load Balancer Controller](https://kubernetes-sigs.github.io/aws-load-balancer-controller/)
- AWS Bedrock Anthropic Claude / Amazon Nova 系列
