# 架构设计详解

> 本文是架构层面的"为什么这样设计"——三栈资源清单、节点布局、扩缩容、模型配置与认证、安全姿态。
> 部署操作看 [`DEPLOYMENT.md`](../DEPLOYMENT.md);本文不含任何操作步骤。

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

## 模型配置与认证模型(对齐生产)

litellm 的 configmap 由 `cdk/lib/helpers/model-config-builder.ts` **在 synth 时动态生成**
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

## 参数化(真实值不进 git)

经 `-c` 或本地 `cdk.context.json` 传入(gitignored——从 `cdk.context.example.json` 复制):

| Context key | 含义 | 示例 |
|---|---|---|
| `domain` | 基础域名;ingress host = `litellm.<domain>`,证书 = `*.<domain>` | `your-domain.example.com` |
| `hostedZoneId` | `<domain>` 的 Route53 hosted zone id(本账号内) | `Z0xxxxxxxxxxxxx` |
| `clusterAdminPrincipals` | 授予 EKS cluster-admin 的 IAM ARN(不给会丢 kubectl) | `["arn:aws:iam::<acct>:role/Admin"]` |

账号/region 来自 `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`(绝不硬编码)。
日常无需手填——`init-env.ts` 自动发现并写入,见 [`01-prerequisites-and-deploy.md`](01-prerequisites-and-deploy.md)。

## 与真实生产环境的已知差距

- 从零建**全新**栈——**不接管**已存在的集群。
