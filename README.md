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

设计细节(三栈资源清单、节点布局、扩缩容、模型配置与认证、安全取舍)在
[`docs/04-architecture.md`](docs/04-architecture.md)。

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

## 快速开始

```bash
cd cdk   # 全部 CDK 代码都在 cdk/ 下
npm install
./scripts/deploy.sh deploy-all --domain your.domain.com --region ap-southeast-1
```

> ⚠️ **部署前必读 [`DEPLOYMENT.md`](DEPLOYMENT.md)**(前置清单 → 一键部署 → 部署后收尾,唯一操作出处)。
> 其中唯一"漏了不报错、pod 静默起不来"的一项:**SALT secret 必须在首次 deploy 前手建**,
> 且是**独立 secret** `<region>-litellm/salt`(**不是** config secret 里的字段),一旦设定永不能改。
> 详见 [`DEPLOYMENT.md` §B5](DEPLOYMENT.md) 与 [`docs/03-gotchas.md` #8](docs/03-gotchas.md)。

只想本地 synth/diff、不部署:

```bash
cd cdk && npm install && npx tsc --noEmit
make init DOMAIN=<domain> REGION=<region>   # 自动发现参数,写 cdk.context.json
npx cdk synth && npx cdk diff               # diff 需要凭证 + bootstrap,不部署任何东西
```

## 仓库结构地图

> 📌 文档里的 `<ACCOUNT_ID>` / `<HOSTED_ZONE_ID>` 等占位符**主流程无需手动替** —— `deploy.sh` + `init-env.ts` 会用你自己的 AWS 凭证自动发现并写进 `cdk.context.json`,你只需给 `--domain` / `--region`。详见 DEPLOYMENT.md 顶部说明。

**顶层布局:**

| 路径 | 是什么 |
|---|---|
| `DEPLOYMENT.md` | **部署总入口**(前置 / 部署 / 后置三段) |
| `cdk/` | **全部 CDK 代码**:`bin/`(应用入口)、`lib/`(三个栈 + helpers/policies)、`scripts/`(`deploy.sh` 一键部署、`init-env.ts` 参数自动发现)、`cdk.json` / `package.json` / `tsconfig.json` 等配置。**部署命令都在这个目录里跑** |
| `docs/` | 编号文档,见下表 |
| `agentcore-websearch-litellm/` | **可选附属服务**:AgentCore Web Search × LiteLLM 集成(独立 Python 子项目,自带 docs) |
| `bedrock-cost-attribution/` | **可选附属服务**:per-team Bedrock 成本归因 hook(Python) |

**`docs/` 编号文档** —— 编号按十位分段:`0x` 主线(部署/架构/排错),`1x` 可选特性。跳号是预留的扩展空间,不是缺文件:

| 文件 | 内容 |
|---|---|
| [`01-prerequisites-and-deploy.md`](docs/01-prerequisites-and-deploy.md) | 前置条件 + 参数自动发现 + 一键部署(深入版) |
| [`02-post-deploy-steps.md`](docs/02-post-deploy-steps.md) | 部署后手工步骤逐条(post 自动化失败时备用) |
| [`03-gotchas.md`](docs/03-gotchas.md) | 部署 / 销毁踩坑速查 |
| [`04-architecture.md`](docs/04-architecture.md) | 架构设计详解:三栈清单、节点布局、扩缩容、模型配置、安全取舍 |
| [`10-optional-gpt-mantle.md`](docs/10-optional-gpt-mantle.md) | GPT-5.x via Bedrock Mantle:API key 生成 + 接入 |
| [`11-optional-agentcore-websearch.md`](docs/11-optional-agentcore-websearch.md) | AgentCore Web Search 部署 + 客户端接入 runbook |
| [`12-monitoring-logging.md`](docs/12-monitoring-logging.md) | SpendLogs / Prometheus / CloudWatch / S3 + 成本归因 |
| [`cost-analysis/README.md`](docs/cost-analysis/README.md) | **部署前先看**:整套基础设施月成本明细(Price List 实价,不含模型调用费) |

## 贡献

欢迎 Issue / PR——尤其是:

- 新的 Bedrock region 支持(更多 inference-profile 前缀)
- 减少部署后手工步骤(例如用 external-dns 接管 Route53 alias)
- 给 model-config builder 和 NodePool zones 补 CDK assertion 测试
- 其他踩坑与修复(已知的见 [docs/03-gotchas.md](docs/03-gotchas.md))

## License

MIT © 2026 — 见 [LICENSE](LICENSE)。

## 致谢

- [LiteLLM](https://github.com/BerriAI/litellm) by BerriAI
- [External Secrets Operator](https://external-secrets.io/) · [Karpenter](https://karpenter.sh/) · [AWS Load Balancer Controller](https://kubernetes-sigs.github.io/aws-load-balancer-controller/)
- AWS Bedrock Anthropic Claude / Amazon Nova 系列
