# LiteLLM on EKS — CDK (full-stack reproduction)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CDK](https://img.shields.io/badge/IaC-AWS%20CDK%20(TypeScript)-orange.svg)](https://aws.amazon.com/cdk/)
[![EKS](https://img.shields.io/badge/EKS-1.35-blue.svg)](https://aws.amazon.com/eks/)

One-shot, parameter-driven CDK (TypeScript) that reproduces a production LiteLLM-on-EKS
architecture from zero — deploy to a new region with **only a domain + region**:
VPC → EKS → Karpenter → RDS / Redis / S3 → Cognito SSO → ACM → WAF → LiteLLM + searxng.

This is a field-tested IaC distillation: `scripts/init-env.ts` auto-discovers every
account-specific parameter (account, AZs with NodePool capacity, hosted zone, RDS
version, Bedrock model availability), and the litellm config is generated at synth
time per region. One `./scripts/deploy.sh` brings up three stacks end-to-end.

## 选型原则

This reproduction follows a few deliberate principles — adjust per environment:

1. **Parameter-driven, zero hardcoded values.** Account/region come from the AWS
   environment; domain/zone/AZs/RDS-version/Bedrock-profiles are auto-discovered by
   `init-env.ts`. Source has no real values (grep-verified in CI of every push).
2. **Least privilege.** Bedrock IRSA is scoped to `foundation-model/*` +
   `inference-profile/*` (not `*`); RDS/Redis SGs are `allowAllOutbound: false`.
3. **Secrets never on disk.** Credentials live in AWS Secrets Manager and reach pods
   via External Secrets Operator (ESO) — never in code, ConfigMaps, or values files.
4. **Faithful to prod topology.** 3 replicas, maxSurge 0, taint-exclusion scheduling,
   HPA/PDB and NodePool mirror the live cluster rather than a textbook default.
5. **Pinned, reproducible images.** searxng and the litellm-database image are pinned
   to exact tags, never `:latest`.

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
| `bin/` · `lib/` | CDK 应用入口 + 三个栈(network / data / cluster)与 helpers/policies |
| `scripts/` | `deploy.sh`(一键部署)、`init-env.ts`(参数自动发现) |
| `cdk.json` · `package.json` · `tsconfig.json` · `cdk.context*.json` | CDK / Node / TS 配置与参数 |
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

---

## 内容地图

> 下表是本 README 自身的章节导航。

> 🚀 **要部署?从 [`DEPLOYMENT.md`](DEPLOYMENT.md) 开始** —— 部署总入口,覆盖部署前准备 / 执行部署 / 部署后收尾,从头读到尾即可。下表是各专题文档。

| # | 章节 | 内容 |
|---|---|---|
| 1 | [What it creates](#what-it-creates) | 三栈资源清单(Network / Data / Cluster) |
| 2 | [Node architecture](#node-architecture--where-pods-land) | 系统 MNG + Karpenter 混合布局、pod 落点 |
| 3 | [Scaling ceiling](#scaling-ceiling-a-known-nominal-mismatch) | HPA maxReplicas 名义上限与实际容量 |
| 4 | [Parameterization](#parameterization-real-values-stay-out-of-git) | 真实值如何经 context 注入(零硬编码) |
| 5 | [Deploy to a new region](docs/01-prerequisites-and-deploy.md) | 一键换区 + 自动发现 + 部署后步骤 + 排错 |
| 6 | [Build / synth / dry-run](#build--synth--dry-run) | 本地构建、synth、cdk diff |
| 7 | [Must-do at deploy](#must-do-before--at-deploy-otherwise-pods-crashloop) | searxng settings + 填 CHANGE_ME 密钥 |
| 8 | [Config / auth model](#config--auth-model-aligned-to-prod) | 模型表生成、IRSA/openai provider、超时 |
| 9 | [Security posture](#security-posture-deliberate-choices) | WAF Count-only / EKS 端点 / IRSA scope |
| 10 | [Known gaps](#known-gaps-vs-a-live-prod-env) | 与真实生产的已知差距 |

## What it creates

| Stack | Resources |
|---|---|
| **litellm-Network** | VPC (10.0.0.0/16, 2 AZ, 1 NAT) + EKS/Karpenter subnet discovery tags + shared node SG |
| **litellm-Data** | RDS Postgres (Multi-AZ) + ElastiCache Redis (7.1, Multi-AZ, **transit encryption + AUTH**) + S3 logs + Secrets Manager (3 secrets: `<region>-litellm/config`, RDS-managed master, `<region>-litellm/redis-auth`) |
| **litellm-Cluster** | EKS 1.35 + OIDC + IRSA (Karpenter/ALB-controller/ESO + **litellm-sa** Bedrock/S3) + Helm (external-secrets, aws-lbc, karpenter) + **Cognito** (UserPool/Client/Domain for UI SSO) + **ACM** `*.<domain>` + **WAFv2** `litellm-waf` + k8s manifests (ns, ESO store/ExternalSecret, ConfigMap, Deployment ×3, Service, internet-facing Ingress, HPA `litellm-hpa`, PDB `litellm-pdb`, EC2NodeClass, NodePool `litellm-nodepool` arm64 r6g/r7g, **searxng**) |

Topology baked in: 3 replicas, maxSurge 0 / maxUnavailable 1, req 2cpu/4Gi limit 4cpu/8Gi,
`--num_workers 2`, config at `/app/config/config.yaml`, HPA min3/max20 cpu65%/mem80%,
NodePool arm64 r6g/r7g .xlarge/.2xlarge.

## Node architecture — where pods land

This is a **hybrid** layout (not pure Karpenter): a small fixed managed nodegroup
for controllers, plus Karpenter-provisioned nodes for the app.

| Node group | What | Who runs there | Gate |
|---|---|---|---|
| **System MNG** | EKS managed nodegroup, `t3.medium × 2`, tainted `CriticalAddonsOnly=true:NoSchedule` | controllers only: external-secrets, aws-lbc, karpenter, metrics-server — each carries a matching **toleration** | the taint blocks everything without that toleration |
| **Karpenter nodes** | dynamically provisioned by NodePool `litellm-nodepool` (arm64 r6g/r7g) | the litellm pods (+ searxng) | — |

`defaultCapacity: 0`, so the **only** standing nodes are the 2 system `t3.medium`s;
all app capacity comes from Karpenter on demand.

**How litellm is kept off the system nodes — by exclusion, not a whitelist.**
The litellm Deployment has **no `CriticalAddonsOnly` toleration and no `nodeSelector`**
(matching prod's empty nodeSelector). Since the system MNG is tainted and litellm
can't tolerate it, the scheduler's only remaining candidates are the untainted
Karpenter nodes. (A common alternative is to pin litellm with an explicit
`nodeSelector: provisioned-by=karpenter` — a whitelist; we use the taint-exclusion
form to mirror prod.)

> Consequence for `topologySpreadConstraints`: the `DoNotSchedule` /
> `ScheduleAnyway` choice only governs how litellm spreads **across Karpenter
> nodes** — it never lets a pod reach a system node (that gate is the taint, not
> topology). The hostname constraint (`maxSkew:1` + `DoNotSchedule`) currently
> means **one litellm pod per node**; relaxing it to `ScheduleAnyway` would pack
> more pods per node but stays entirely within the Karpenter pool.

### Scaling ceiling (a known nominal mismatch)

`HPA maxReplicas: 20` is a nominal cap that the current NodePool can't actually
reach: `limits.cpu: 32` ÷ 2 cpu/pod = ~16 pods, and "one pod per node" caps it at
4 (r*.2xlarge, 8 vCPU) – 8 (r*.xlarge, 4 vCPU). This matches prod (which also runs
`limits.cpu 32` + `DoNotSchedule` and in practice sits at 3 pods / 3 nodes — never
near 20). To make 20 genuinely reachable you'd raise `limits.cpu` to ≥48 and
relax the hostname constraint to `ScheduleAnyway`; left as-is to stay faithful to prod.

## Parameterization (real values stay out of git)

Pass via `-c` or a local `cdk.context.json` (gitignored — copy from `cdk.context.example.json`):

| Context key | Meaning | Example |
|---|---|---|
| `domain` | base domain; ingress host = `litellm.<domain>`, cert = `*.<domain>` | `your-domain.example.com` |
| `hostedZoneId` | Route53 hosted zone id for `<domain>` (in-account) | `Z0xxxxxxxxxxxxx` |
| `clusterAdminPrincipals` | IAM ARNs granted EKS cluster-admin (else you lose kubectl) | `["arn:aws:iam::<acct>:role/Admin"]` |

Account/region come from `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION` (never hardcoded).

## Deploy to a new region (parameter-driven)

One command — `scripts/init-env.ts` auto-discovers account, AZs (with NodePool
capacity), hosted zone, **RDS Postgres version**, and Bedrock model availability;
only `--domain` is required. Full walkthrough + post-deploy steps + troubleshooting:
**[docs/01-prerequisites-and-deploy.md](docs/01-prerequisites-and-deploy.md)**.

```bash
cd cdk   # all CDK code lives under cdk/
./scripts/deploy.sh --domain your.domain.com --region ap-southeast-1 --host-prefix litellm-sin
# or: make init/synth/deploy  (DOMAIN=... REGION=... HOST_PREFIX=... [MAX_AZS=2])
```

## Build / synth / dry-run

```bash
cd cdk          # all CDK code lives under cdk/
npm install
npx tsc --noEmit
# auto-discover params first, then synth/diff (CDK reads cdk.context.json)
make init DOMAIN=<domain> REGION=<region>
npx cdk synth
npx cdk diff   # dry-run against AWS (needs creds + bootstrap; deploys nothing)
```

Manual fallback (skip init-env, pass everything by hand):
```bash
CDK_DEFAULT_ACCOUNT=<acct> CDK_DEFAULT_REGION=<region> \
  npx cdk synth -c domain=<domain> -c hostedZoneId=<zoneId> -c clusterAdminPrincipals='["arn:..."]'
```

## Must-do before / at deploy (otherwise pods CrashLoop)

These are NOT optional — skipping them leaves the cluster unhealthy:

1. **searxng `settings.yml`** — the committed ConfigMap is a `# placeholder` only.
   searxng will CrashLoop without a valid `settings.yml` (needs at least
   `server.secret_key`), which then breaks litellm's web-search interception
   (`SEARXNG_API_BASE`). Inject a real `settings.yml` at deploy time (e.g.
   `kubectl create configmap searxng-config --from-file=settings.yml=... --dry-run=client -o yaml | kubectl apply -f -`)
   before the searxng pod stabilizes.
2. **Fill the `CHANGE_ME` secrets** — `aws secretsmanager update-secret --secret-id <region>-litellm/config`:
   `GENERIC_CLIENT_ID`/`GENERIC_CLIENT_SECRET` (from the `litellm-ui` Cognito client, see step 1 below),
   `LITELLM_SALT_KEY`, `BEDROCK_MANTLE_API_KEY`, `GEMINI_API_KEY`, `UI_PASSWORD`.
   `LITELLM_MASTER_KEY` is auto-generated. **`REDIS_PASSWORD` is wired automatically**
   to the ElastiCache AUTH token (the `<region>-litellm/redis-auth` secret) — do NOT set it by hand.

## Post-deploy manual steps (cannot be done at synth)

1. **Cognito → secret** — push the `litellm-ui` Cognito client id/secret into the config secret
   (`GENERIC_CLIENT_ID`/`GENERIC_CLIENT_SECRET`); see the `PostDeploySecretReminder` stack output.
2. **Route53 A-alias** — `litellm.<domain>` → ALB DNS. The ALB is created by the in-cluster ALB
   controller *after* pods run, so its DNS isn't known at synth; create the alias manually or via external-dns.
3. **Sub-domain delegation** — if `<domain>` is a delegated sub-zone, ensure the parent zone's NS records point here.

## Config / auth model (aligned to prod)

The litellm configmap is **generated at synth time** by
`lib/helpers/model-config-builder.ts` (no static YAML file) — it picks the right
Bedrock inference-profile prefix (`us./global./apac.`) per region from the
profiles init-env discovered, and drops models a region doesn't offer. The model
set below is what the builder emits when all profiles are available:

- **Bedrock Claude / Nova** authenticate via **IRSA** — the litellm pod runs as SA
  `litellm-sa` (created in `ClusterStack`) whose IAM role has `bedrock:InvokeModel*` /
  `bedrock:Converse*`. No AKSK in config; entries carry only `aws_region_name`.
- **GPT-5.x / Grok** (Bedrock Mantle) use the `openai/` provider + `BEDROCK_MANTLE_API_KEY`
  against the `/openai/v1` base (litellm appends `/responses` → call `/v1/responses`).
- **Gemini** uses `GEMINI_API_KEY`.
- Full model set: `claude-fable-5` (+`[1m]`), opus-4-8/4-7/4-6, sonnet-4-6 (+`[1m]`),
  haiku-4-5, nova-{premier,pro,lite,micro}, gemini-3.5-flash/3.1-flash-image,
  gpt-5.5/5.4 (+ Oregon fallback), grok-4.3, and the Codex guardian aliases
  (`codex-auto-review` / `gpt-5.4-mini` / `gpt-5` / `gpt-5-codex`).
- **WebSearch interception** + `searxng-search` search tool + **`s3_v2`** request-log
  callback are wired in (the S3 bucket name is injected at synth from `DataStack`).
- `router_settings.timeout: 1200` aligns with the ALB idle timeout.
- Image pinned to `ghcr.io/berriai/litellm-database:v1.84.3` (override via
  `-c litellmImage=...` or `cdk.json`).

## Security posture (deliberate choices)

These mirror the live prod setup intentionally — change them per environment if needed:

- **WAF managed rule groups are Count-only.** `CommonRuleSet` and `KnownBadInputs`
  run in `overrideAction: count` (observe, don't block) to match the live WAF; only
  the **per-IP rate limit (priority 3) blocks**. Real protection is API-key / master-key
  auth. To actually block, flip a rule group's `overrideAction` to `none`.
- **EKS API endpoint is `PUBLIC_AND_PRIVATE`** so kubectl works from a laptop without a
  bastion/VPN (verification convenience). Lock down with `publicAccessCidrs` for prod.
- **Bedrock IRSA** is scoped to `foundation-model/*` + `inference-profile/*`
  (not `*`).

## Known gaps vs a live prod env

- `searxng` `settings.yml` is a placeholder ConfigMap — inject real settings at deploy time (see must-do step 1).
- Builds a **new** stack from zero — does **not** adopt an existing cluster.

## Contributing

Issues / PRs welcome — especially:

- New Bedrock region support (additional inference-profile prefixes)
- Reducing the post-deploy manual steps (e.g. external-dns for the Route53 alias)
- CDK assertion tests for the model-config builder and NodePool zones
- Other gotchas and fixes (see [docs/01-prerequisites-and-deploy.md](docs/01-prerequisites-and-deploy.md) for the ones found so far)

## License

MIT © 2026 — See [LICENSE](LICENSE).

## Acknowledgments

- [LiteLLM](https://github.com/BerriAI/litellm) by BerriAI
- [External Secrets Operator](https://external-secrets.io/) · [Karpenter](https://karpenter.sh/) · [AWS Load Balancer Controller](https://kubernetes-sigs.github.io/aws-load-balancer-controller/)
- AWS Bedrock Anthropic Claude / Amazon Nova series
