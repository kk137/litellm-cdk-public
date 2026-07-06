# 部署到新区域 — 操作手册

> 📍 **新手从 [`../DEPLOYMENT.md`](../DEPLOYMENT.md) 开始**(部署总入口)。本文是其中前置条件 + 参数发现部分的**深入版**。
>
> 目标:换一个区域部署,只改参数(`--domain` + `--region`),其余自动发现。
> 本文覆盖:**部署前的前置条件(及如何获取/部署)**、一键部署流程、init-env 自动发现了什么、**部署后必做的手工步骤**、以及实战踩过的坑与排查。

---

## 0. 前置条件(部署前必须满足)

下面分两类:**A. 本地工具链**(你这台机器要装的)、**B. 目标 AWS 账号侧**(账号里要先有的)。每项都给「怎么检查」+「怎么获取/部署」。

> `./scripts/deploy.sh` 启动时只自动检查了 A 的 aws/npx/凭证三项;B 类不满足不会在启动时报错,而是部署到对应栈时才失败。所以**部署前请照下表自查一遍**。

### A. 本地工具链

| 工具 | 检查 | 没有怎么装(macOS) |
|---|---|---|
| AWS CLI v2 | `aws --version` | `brew install awscli` |
| Node.js 18+ / npx | `node -v && npx -v` | `brew install node` |
| kubectl | `kubectl version --client` | `brew install kubectl` |
| AWS 凭证(已配置且有效) | `aws sts get-caller-identity` 能返回账号 | `aws configure` 或 `aws sso login` / 设 `AWS_PROFILE` |

> CDK 本身不用全局装,`npx cdk` 会用项目里 devDependency 的版本。首次跑前在项目目录 `npm install`。

### B. 目标 AWS 账号侧

#### B1. Route53 HostedZone(**硬前置,缺了 init 直接报错**)

- **为什么必须**:ACM 证书走 DNS 验证、Cognito 回调、ALB A-alias 都依赖它。`init-env` 找不到会抛 `No hosted zone found for domain`。
- **怎么检查**(把 `your.domain.com` 换成你要用的域名):
  ```bash
  aws route53 list-hosted-zones-by-name --dns-name your.domain.com \
    --query "HostedZones[?Name=='your.domain.com.'].[Id,Name]" --output table
  ```
  init-env 会逐级向上匹配父域,所以子域(`litellm.your.domain.com`)只要父域 zone(`your.domain.com`)存在即可。
- **没有怎么获取**:
  - **已有域名,只是没建 zone**:`aws route53 create-hosted-zone --name your.domain.com --caller-reference $(date +%s)`,然后把输出里的 NS 记录配到域名注册商。
  - **完全没有域名**:先在 Route53 注册一个(`aws route53domains register-domain`,需在 us-east-1),或用已有的内部域名委派一个子域 zone。
  - **域名在别处托管**:在 Route53 建 zone 后,到原 DNS 服务商把该(子)域 NS 委派给 Route53 的 NS。

#### B2. Bedrock 模型访问已开通(**软前置,不开通则该模型被跳过**)

- **为什么必须**:LiteLLM 调模型靠 Bedrock。模型访问要在账号/区域级别先 enable。
- **怎么检查**(列出目标区域可用的推理配置文件,init-env 也是读这个):
  ```bash
  aws bedrock list-inference-profiles --region <REGION> \
    --query 'inferenceProfileSummaries[].inferenceProfileId' --output table
  ```
- **没开通怎么处理**:Console → Bedrock → Model access → 勾选要用的模型(Claude / Nova 等)申请访问。开通后重跑 `init-env`,模型会自动进 catalog。
- **不致命**:某模型没开通,`model-config-builder` 会自动跳过它(不会让部署失败),只是能用的模型变少。

#### B3. 部署者 IAM 权限(**硬前置**)

- **为什么必须**:CDK 要建 VPC / EKS / RDS / ElastiCache / Cognito / ACM / WAF / Secrets / IAM / Route53 全栈。
- **怎么检查**:最简单是用有 `AdministratorAccess` 的身份;若用受限角色,至少要覆盖上述服务的 create/update/delete + `iam:CreateRole`/`PassRole` + `cloudformation:*`。
- **不足的后果**:某步 `AccessDenied`,CFN 栈 ROLLBACK。

#### B4. CDK Bootstrap(**硬前置,首次在该账号+区域必做**)

- **为什么必须**:CDK 部署前要在目标账号+区域建一套 bootstrap 资源(S3 assets 桶、ECR、执行角色)。
- **怎么检查**:
  ```bash
  aws cloudformation describe-stacks --stack-name CDKToolkit --region <REGION> >/dev/null 2>&1 \
    && echo "已 bootstrap" || echo "未 bootstrap,需跑 deploy.sh bootstrap"
  ```
- **怎么做**:`./scripts/deploy.sh bootstrap`(已封装,`deploy-all` 会自动跑)。

#### B5. SALT secret(**硬前置,CDK 不创建,缺了 pod 起不来**)

- **为什么必须**:`LITELLM_SALT_KEY` 对称加密 DB 里的虚拟 key/provider 凭证。它一旦设定**永不能改**(改了所有已存 key 解不开),所以 CDK **故意不创建/不拥有**它(避免 CloudFormation 替换或重生成 brick 掉 DB key)—— 见 `lib/data-stack.ts` 的 `fromSecretNameV2`(只引用)。CDK 与 `deploy.sh`/`init-env` **都不会自动建它**。
- **不建的后果(静默)**:`cdk synth`/`deploy` **不报错**(`fromSecretNameV2` 不校验存在性),但起 pod 时 ESO 同步 `salt.LITELLM_SALT_KEY` 失败 → litellm 拿不到 SALT,起不来或加密失效。
- **怎么做(首次 deploy 前,一次性)**:secret 名必须是 `<region>-<projectName>/salt`,JSON 里键名是 `LITELLM_SALT_KEY`:
  ```bash
  SALT=$(openssl rand -hex 16)   # 32 字符,真随机
  aws secretsmanager create-secret \
    --name "<REGION>-litellm/salt" \
    --description "LiteLLM SALT key (encrypts DB-stored virtual keys; never rotate)" \
    --secret-string "{\"LITELLM_SALT_KEY\":\"$SALT\"}" \
    --region <REGION>
  # ⚠️ 立即把 $SALT 备份到密码管理器 —— 丢了 = DB 里所有虚拟 key 报废,只能清库重建
  ```
- **注意**:SALT **不是**填进 `config` secret 的字段,而是这个**独立的 `/salt` secret**(代码读的是 `salt.LITELLM_SALT_KEY`,不是 `config.LITELLM_SALT_KEY`)。

### C. 可选 provider key(只用 Claude/Nova 可全部跳过)

> 这些都是**外部凭证**,CDK 不生成。只在你要用对应模型时才需要,部署后手工填进 `config` secret(见 §3.2)。不填只影响对应模型,不影响 Claude/Nova(走 IRSA)。

| 项 | 说明 |
|---|---|
| **Mantle API Key**(GPT-5.x) | `bedrock-mantle.{region}.api.aws/openai/v1` 是 **Amazon Bedrock 公开 endpoint**(GPT-5.5/5.4 于 2026-06-01 GA),任何账号都能在 **Bedrock 控制台 → API keys → Long-term** 自助生成长期 key(`ABSK` 开头),前提是该 region 已开通对应 GPT 模型访问。生成与接入步骤见 [`10-optional-gpt-mantle.md`](./10-optional-gpt-mantle.md)。不填则这些模型条目调不通(401)。 |
| **Gemini API Key** | 要自己的 Google API key,部署后手工填(见 §3.2),不填则 Gemini 不可用。 |

### D. 仅 Amazon 内部环境相关(外部账号可忽略)

| 项 | 说明 |
|---|---|
| **`auto-delete=no` tag** | 是本团队账号特有的资源回收机制识别 tag。CDK 已自动打,在没有该回收器的账号里无害但无意义。 |

---

## 1. 一键部署

> 先确认 §0 前置条件都满足,再开始。

```bash
cd ~/litellm-cdk/cdk   # CDK 代码都在 cdk/ 子目录
npm install   # 首次跑前装依赖

# 推荐:一条命令全自动(init → bootstrap → network → data → cluster → post)
./scripts/deploy.sh deploy-all --domain your.domain.com --region <REGION> --host-prefix litellm-sin

# 或分步(每步可停下检查)
./scripts/deploy.sh init --domain your.domain.com --region <REGION> --host-prefix litellm-sin
./scripts/deploy.sh bootstrap
./scripts/deploy.sh deploy-network
./scripts/deploy.sh deploy-data
./scripts/deploy.sh deploy-cluster
./scripts/deploy.sh post     # 自动:Route53 alias + Cognito secret 写回 + admin 用户 + 重启验证
```

可选参数:
- `--host-prefix`(默认 `litellm`)→ 入口域名 = `<host-prefix>.<domain>`
- `--max-azs`(默认 `2`)→ NodePool/网络用几个 AZ。验证用 2,生产 HA 可设 3

部署耗时约 30–45 分钟(EKS 控制面 + 节点最慢)。

> **`post` 已自动化**了过去需要手工的大部分步骤(Route53 A-alias、Cognito client secret 写回、admin 用户创建、rollout restart + 验证)。下面第 3 节保留为**原理说明 + 排错备用**——当 `post` 某步打 WARN 跳过时照着补。真正仍需人工的只剩 Mantle/Gemini key(见 §3.2,只用 Claude/Nova 时用不到)。

---

## 2. init-env 自动发现了什么(无需手填)

`scripts/init-env.ts` 调 AWS API 生成 `cdk.context.local.json`:

| 参数 | 来源 API | 说明 |
|------|---------|------|
| accountId | `sts get-caller-identity` | 当前会话账号 |
| nodepoolZones | `ec2 describe-availability-zones` + `describe-instance-type-offerings` | **只保留有 NodePool 实例容量的 AZ**,按 `--max-azs` 截断(解决坑 #3) |
| hostedZoneId | `route53 list-hosted-zones-by-name` | 用 domain 逐级向上匹配父域 |
| **postgresVersion** | `rds describe-db-engine-versions` | **自动选该区最高 16.x**(解决坑 #1:不同区可用版本不同) |
| bedrockProfiles | `bedrock list-inference-profiles` | 决定模型用 `us./global./apac.` 前缀,不可用的模型自动剔除 |
| clusterAdminPrincipals | 默认 = 当前 caller ARN | kubectl 管理权限 |

**只有 `--domain` 必须手填**(业务决策,无法从 AWS 推断)。

---

## 3. 部署后步骤(`post` 已自动 / 手工备用)

> **正常路径**:`deploy.sh post` 已自动完成 3.2(Cognito secret 部分)、3.4、3.5,并做了重启验证。本节是**原理说明 + 当 post 某步失败时的手工补做**。仅 3.2 的 Mantle/Gemini key 一定要人工(只用 Claude/Nova 时不需要)。

CDK 只建基础设施 + 空壳密钥/用户。以下各步是 `cdk deploy` 之后才能做的事。

### 3.1 更新 kubeconfig

```bash
aws eks update-kubeconfig --name litellm-cluster --region <REGION>
```

### 3.2 填密钥(Secrets Manager → ExternalSecret 同步)

密钥都在 `<region>-litellm/config` 这个 Secret 里,CDK 建时填的是 `CHANGE_ME` 占位符。

| Key | 用途 | 不填的后果 |
|-----|------|-----------|
| `BEDROCK_MANTLE_API_KEY` | GPT-5.x / Grok(走 Mantle US 端点) | 这些模型 401;Bedrock Claude/Nova 不受影响(走 IRSA) |
| `GEMINI_API_KEY` | Google Gemini | Gemini 不可用 |
| `UI_PASSWORD` | LiteLLM UI 本地登录(非 SSO 路径) | 见 3.4,SSO 模式下用不到 |
| `GENERIC_CLIENT_ID` / `GENERIC_CLIENT_SECRET` | Cognito SSO 回调 | UI SSO 登录失败 |

更新方法(以 Mantle key 为例,**用 node 不用 python**,见坑 #7):

```bash
SECRET="<region>-litellm/config"
CUR=$(aws secretsmanager get-secret-value --secret-id "$SECRET" --region <REGION> --query SecretString --output text)
NEW=$(echo "$CUR" | KEY="sk-..." node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);j.BEDROCK_MANTLE_API_KEY=process.env.KEY;process.stdout.write(JSON.stringify(j))})")
aws secretsmanager put-secret-value --secret-id "$SECRET" --region <REGION> --secret-string "$NEW"

# 强制 ESO 立即同步 + 重启 pod 加载
kubectl annotate externalsecret litellm-secrets -n litellm force-sync=$(date +%s) --overwrite
kubectl rollout restart deployment/litellm -n litellm
```

`GENERIC_CLIENT_SECRET` 取自 Cognito:
```bash
aws cognito-idp describe-user-pool-client --user-pool-id <POOL_ID> \
  --client-id <CLIENT_ID> --region <REGION> --query 'UserPoolClient.ClientSecret' --output text
```
(POOL_ID / CLIENT_ID 见 ClusterStack 的 `UserPoolId` / `UserPoolClientId` 输出)

### 3.3 SearXNG settings.yml(**开箱即用,通常无需操作**)

> `settings.yml` 的**源**是 `cdk/lib/cluster-stack.ts` 里的 `searxngSettingsYaml` 常量(含非空 `secret_key` + 引擎列表),synth 时生成 ConfigMap、Deployment 挂载好——全新部署 searxng 直接 Running。仓库里**没有**独立的 settings.yml 文件,改配置就是改这段 TS。

想自定义(换搜索引擎、调 safe_search 等),按 IaC 正道走:

```bash
# 1. 编辑 cdk/lib/cluster-stack.ts 中的 searxngSettingsYaml(搜这个常量名)
# 2. 重新部署 Cluster 栈(只会更新 ConfigMap)。⚠️ 钉死 region(见 gotcha #1)
AWS_REGION=<REGION> AWS_DEFAULT_REGION=<REGION> \
CDK_DEFAULT_REGION=<REGION> CDK_DEFAULT_ACCOUNT=<ACCOUNT_ID> \
npx cdk deploy litellm-Cluster
# 3. searxng 不会自动重载,重启使其生效
kubectl rollout restart deployment/searxng -n litellm
```

临时试验(改动会在下次 `cdk deploy` 时被 TS 源覆盖,验证好了记得写回 cluster-stack.ts):

```bash
kubectl edit configmap searxng-config -n litellm
kubectl rollout restart deployment/searxng -n litellm
```

> 没有 SearXNG:`websearch_interception` 不可用,但普通 chat/completion 正常。

### 3.4 Cognito 用户 + admin group(解决坑 #6)

UI 设了 `AUTO_REDIRECT_UI_LOGIN_TO_SSO=true`,登录**直接跳 Cognito**(没有用户名/密码框)。User Pool 默认 `AllowAdminCreateUserOnly=true`(禁自注册),需管理员建用户。

```bash
POOL=<UserPoolId>   # ClusterStack 输出

# 1. 建用户(临时密码,首次登录强制改)
aws cognito-idp admin-create-user --user-pool-id $POOL --region <REGION> \
  --username admin --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
  --temporary-password 'TempPass123!' --message-action SUPPRESS

# 2. 建 admin group 并加入(否则登进去是普通用户:看不到模型、不能建 key)
aws cognito-idp create-group --group-name admin --user-pool-id $POOL --region <REGION>
aws cognito-idp admin-add-user-to-group --user-pool-id $POOL --username admin --group-name admin --region <REGION>
```

角色映射(LiteLLM env `GENERIC_ROLE_MAPPINGS_ROLES`):`admin→proxy_admin`、`viewer→proxy_admin_viewer`、`users→internal_user`。**加完 group 必须重新登录**才能拿到带 group 的新 token。

### 3.5 Route53 A-alias(公网访问)

ALB DNS 部署后才知道,需手动建 alias 指过去:

```bash
ALB=$(kubectl get ingress litellm -n litellm -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
ALB_ZONE=$(aws elbv2 describe-load-balancers --region <REGION> \
  --query "LoadBalancers[?DNSName=='$ALB'].CanonicalHostedZoneId" --output text)
cat > /tmp/r53.json <<EOF
{"Changes":[{"Action":"UPSERT","ResourceRecordSet":{
  "Name":"<host-prefix>.<domain>","Type":"A",
  "AliasTarget":{"HostedZoneId":"$ALB_ZONE","DNSName":"dualstack.$ALB","EvaluateTargetHealth":true}}}]}
EOF
aws route53 change-resource-record-sets --hosted-zone-id <HOSTED_ZONE_ID> --change-batch file:///tmp/r53.json
```

### 3.6 验证

```bash
curl https://<host-prefix>.<domain>/health/readiness   # 期望 {"status":"healthy","db":"connected"}

# 直接打 API(master key 取自 secret)
MK=$(kubectl get secret litellm-secrets -n litellm -o jsonpath='{.data.LITELLM_MASTER_KEY}' | base64 -d)
curl https://<host-prefix>.<domain>/v1/chat/completions -H "Authorization: Bearer $MK" \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"hi"}],"max_tokens":20}'
```

---

## 4. 实战踩坑速查

| # | 现象 | 根因 | 现状/解法 |
|---|------|------|----------|
| 1 | Data 栈 `CREATE_FAILED`:`Cannot find version 16.8 for postgres` | RDS 版本硬编码,但目标区无此版本 | **已修**:init-env 自动发现最高 16.x → context `postgresVersion` |
| 2 | 重部报 S3 桶 `already exists` | 桶是 RETAIN,失败回滚时栈删了桶残留 | 手动 `aws s3 rb s3://litellm-logs-<acct>-<region>` 后重部 |
| 3 | 第 3 个 pod 永远 Pending,Karpenter 报 no offering | TopologySpread 排到无 Graviton 容量的 AZ | **已修**:init-env 只写有容量的 AZ + `--max-azs 2` |
| 4 | searxng `CrashLoopBackOff`(`Invalid settings.yml`) | 旧 CDK 只放 placeholder ConfigMap | **已修**:CDK 内置完整 settings.yml(含非空 secret_key) |
| 5 | 本机 `curl` 域名 `Could not resolve host`,但 IP 直连通 | 本机/公司 DNS resolver 对新子记录同步延迟 | 等同步,或临时 `/etc/hosts` 加 IP;非部署问题 |
| 6 | SSO 登进去无管理员权限/看不到模型 | Cognito 用户没加 admin group | `post` 已自动建用户+组;若手工建漏了组见 3.4,**加完组必须重新登录** |
| 7 | 改 Secret 时 `PermissionError: Operation not permitted` | macOS TCC 对桌面目录拦 python | 用 `node` 处理 JSON 代替 python |
| 8 | UI 跳 Cognito 报 `invalid_request`,URL 带 `client_id=CHANGE_ME` | 改完 secret 没重启 pod;`envFrom` 只在启动时读一次 | `post` 已自动重启验证;手工补救:`kubectl rollout restart deployment/litellm -n litellm`,再 `kubectl exec ... printenv GENERIC_CLIENT_ID` 确认非 CHANGE_ME |

---

## 5. 自动化现状 / 仍需人工

已收进 IaC 或 `post` 脚本(全新部署自动完成,重部不丢):
- SearXNG settings.yml — CDK 内置完整配置
- Route53 A-alias — `post` 自动 UPSERT
- Cognito client secret 写回 + admin 用户 — `post` 自动(幂等)
- rollout restart + 验证 — `post` 自动

仍需人工:
- **SALT secret** — **部署前**必须手动创建(独立 `/salt` secret),CDK 不建;见 §0 B5(硬前置)
- **Mantle API Key**(GPT-5.x)— Bedrock 控制台自助生成(`10-optional-gpt-mantle.md`);见 §3.2(仅用到时)
- **Gemini API Key** — 自备 Google key;见 §3.2(仅用到时)

> ⚠️ **SALT 注意**:SALT 是 deploy 前手建的独立 secret,且**一旦设定永不能改**(改了 DB 里所有已存 key 解不开)。已有虚拟 key 的现网集群尤其不要动 SALT。
