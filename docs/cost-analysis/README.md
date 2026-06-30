# LiteLLM-on-EKS CDK — 部署成本分析

> **用途**:评估把这套 CDK 真 `cdk deploy` 到环境做正式验证,大概要花多少钱。
> **数据来源**:AWS Price List API 实时查询(us-east-1),查询日期 **2026-06-18**。
> **口径**:On-Demand,月按 730 小时折算。**不含 Bedrock/Mantle 模型调用费**(按 token 走,与基础设施无关)。
> **资源规格**:全部从本仓库代码实读(`lib/data-stack.ts` / `lib/cluster-stack.ts` / `lib/network-stack.ts`),非估算。

---

## 1. 计价资源清单(从代码实读)

| 资源 | 规格 | 数量 | 代码位置 |
|---|---|---|---|
| EKS 控制面 | Kubernetes 1.35 | 1 集群 | cluster-stack |
| RDS Postgres | `db.m6g.large`,**Multi-AZ**,GP3 100GB,PI + 增强监控 60s | 1 | data-stack |
| ElastiCache Redis | `cache.t3.medium`,**2 节点** Multi-AZ,7.1,transit 加密+AUTH | 1 组 | data-stack |
| System 管理节点(MNG) | `t3.medium` On-Demand,20GB,`CriticalAddonsOnly` taint | 2 台 | cluster-stack |
| Karpenter 业务节点 | 稳态 3 pod / 3 node,每 pod 2 核 → `r7g.xlarge`(4 核) | 3 台 | NodePool |
| NAT Gateway | — | 1 | network-stack (`natGateways: 1`) |
| ALB | internet-facing | 1 | Ingress (ALB controller 建) |
| S3 / Secrets Manager / WAFv2 / CloudWatch / EBS | 杂项 | — | 多处 |

> **稳态规模 = 3 pod / 3 node**,这是生产实际运行规模(HPA min 3;`maxReplicas: 20` 是够不着的名义上限,详见主 README 的 "Scaling ceiling" 节)。

---

## 2. 月成本明细(稳态 3 pod / 3 node)

| 项 | 规格 | 单价 (USD) | 月成本 (730h) |
|---|---|---|---|
| EKS 控制面 | 1 集群 | $0.10 /h | **$73** |
| RDS 实例 | db.m6g.large Multi-AZ PG | $0.318 /h | **$232** |
| RDS 存储 | GP3 100GB ×2 (Multi-AZ) | ~$0.092/GB-mo ×2 | **~$18** |
| ElastiCache | cache.t3.medium ×2 | $0.068 /h ×2 | **$99** |
| System MNG | t3.medium ×2 | $0.0416 /h ×2 | **$61** |
| Karpenter 节点 | r7g.xlarge ×3 | $0.2142 /h ×3 | **$469** |
| NAT Gateway | 1 个 + 数据处理 | $0.045 /h + 数据 | **~$35** |
| ALB | internet-facing + LCU | $0.0225 /h + LCU | **~$20** |
| 杂项 | EBS / S3 / Secrets / WAF / CloudWatch / PI | — | **~$30** |
| **合计** | | | **≈ $1,037 / 月** |

**成本结构**:Karpenter 业务节点(~45%)+ RDS Multi-AZ(~24%)是两个大头。

---

## 3. 按验证时长换算

正式验证通常不必跑满一个月:

| 验证时长 | 基础设施成本(约) |
|---|---|
| 1 天 | ~$34 |
| 3 天(跑通 + 冒烟) | ~$102 |
| 1 周(稳妥验证) | ~$238 |
| 1 个月 | ~$1,037 |

---

## 4. 省钱档(验证用,不动生产对齐的默认值)

验证不需要生产级高可用,用 `-c` 覆盖或临时改规格可大幅压低:

| 改动 | 省 | 说明 |
|---|---|---|
| RDS 改 **Single-AZ** | ~-$116/月 | 验证不需要 Multi-AZ 故障切换 |
| Redis 改 **单节点**(`numCacheClusters` 2→1) | ~-$50/月 | 验证不需要副本 |
| litellm **replicas 1**(临时) | ~-$310/月 | 只需 1 pod 跑通就够;少 2 台 r7g.xlarge |
| **合计省钱档** | | **≈ $400–500/月(~$15/天)** |

> 这些是验证档建议,**不要**改进仓库默认值(默认值刻意对齐生产)。用 `cdk deploy -c ...` 临时覆盖,或在 `cdk.context.json`(gitignored)里设。

---

## 5. ⚠️ 验证完务必清理

这套里 RDS / Redis / NAT / EKS / EC2 全是**按小时计费**,忘删会持续烧钱。

```bash
cdk destroy --all
```

**注意两个会挡住 destroy 的保护(刻意设的,防误删生产)**:

- RDS `deletionProtection: true` → 先 `aws rds modify-db-instance --db-instance-identifier <id> --no-deletion-protection --apply-immediately`
- RDS / S3 / Cognito `removalPolicy: RETAIN`(或 RDS 的 `SNAPSHOT`)→ destroy 后这些资源**不会自动删**,需手动清(RDS 会留一个最终快照,S3 桶和 Cognito UserPool 会保留)。

destroy 后建议在控制台确认:RDS 实例/快照、ElastiCache、NAT、EKS、EC2(Karpenter 节点)、ALB 都已消失或按预期保留。

---

## 附:价格随时间变动

本文价格为 2026-06-18 查询的 us-east-1 On-Demand 价。AWS 价格会调整,正式做预算前建议用
[AWS Pricing Calculator](https://calculator.aws/) 或 Price List API 复核当时价。
