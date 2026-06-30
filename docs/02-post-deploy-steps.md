# 新加坡 EKS 部署后操作 — Step by Step

> 📍 **新手从 [`../DEPLOYMENT.md`](../DEPLOYMENT.md) 开始**(部署总入口)。本文是其中「③ 部署后步骤」的**逐条手工版**,供 `deploy.sh post` 某步失败时照着补。

> 占位符提示:`<ACCOUNT_ID>` / `<USER_POOL_ID>` / `<COGNITO_CLIENT_ID>` / `<HOSTED_ZONE_ID>` / `<your-domain>` 等请替换成你自己账号/域名的真实值;示例 region 用 `ap-southeast-1`,换成你的 region。

> ## 🤖 大部分已自动化:先跑 `./scripts/deploy.sh post`
>
> `deploy-cluster` 跑完后,**直接跑 `./scripts/deploy.sh post`**,它会幂等地自动完成:
>
> | 步骤 | post 是否自动 | 说明 |
> |---|---|---|
> | **SALT secret** | ❌ **部署前手建** | CDK 不创建,只引用独立 `/salt` secret;**必须在首次 deploy 前手动 create**(见下方 ⚠️ + Step ② 2.1) |
> | **① Route53 A-alias** | ✅ post 自动 | 读 ingress ALB DNS → UPSERT A-alias |
> | **② Cognito client id/secret** | ✅ post 自动 | describe-user-pool-client 取 secret → 写回 config secret |
> | **③ admin 用户** | ✅ post 自动 | admin-create-user + 加 admin 组,打印临时密码 |
> | **④ rollout restart + 验证** | ✅ post 自动 | 重启 litellm + 验证 pod 拿到真值 |
> | SearXNG settings.yml | ✅ CDK 内置 | 完整 settings.yml 已写进 ConfigMap,通常无需动 |
> | Mantle / Gemini key | ❌ 仍手工 | 外部凭证,只在调 GPT-5.5/Gemini 时才需要,见 Step ② 方式 B |
>
> **所以正常路径是**:`deploy.sh post` → 拿到 admin 临时密码 → 浏览器登录。下面的手工章节是**原理说明 + 排错备用**,当 post 某步打 WARN 跳过时照着补。
>
> ⚠️ **SALT 注意**:SALT **不是** CDK 自动生成的,也**不是**填进 `config` secret 的字段。它是一个 deploy 前必须手动创建的**独立 secret** `<region>-litellm/salt`(代码读 `salt.LITELLM_SALT_KEY`)。CDK 故意只引用不创建(避免 CFN 替换 brick 掉 DB key)。**没建会静默失败**:synth/deploy 不报错,但起 pod 时 ESO 同步失败、litellm 拿不到 SALT。创建命令见 Step ② 2.1。一旦设定**永不能改**(改了 DB 里所有已存 key 解不开)。

部署完成后如果要手工逐步操作(或 post 某步失败需要补),按下面步骤来。

> 假设你已经在 `~/litellm-cdk` 目录,kubeconfig 已切到新加坡集群:
> ```bash
> aws eks update-kubeconfig --name litellm-cluster --region ap-southeast-1
> ```

---

## 部署上下文(实际值速查)

下面的命令使用以下真实值,如果集群重建过这些值会变,先跑一遍 `./scripts/deploy.sh outputs` 拿最新的:

| 字段 | 值 |
|---|---|
| 域名 / 子域名 | `litellm-sg.<your-domain>` |
| Route53 HostedZone Id | `<HOSTED_ZONE_ID>` |
| ALB DNS | `k8s-litellm-litellm-ddd5456bd8-1896667943.ap-southeast-1.elb.amazonaws.com` |
| ALB Canonical HostedZone Id | `Z1LMS91P8CMLE5` |
| Cognito UserPoolId | `<USER_POOL_ID>` |
| Cognito ClientId | `<COGNITO_CLIENT_ID>` |
| LitellmConfig Secret | `ap-southeast-1-litellm/config` |

---

## ① Route53 创建 A-alias 记录

把 `litellm-sg.<your-domain>` 指向 ALB。

```bash
ALB_DNS=$(kubectl get ingress -n litellm litellm \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')

ALB_HZ=$(aws elbv2 describe-load-balancers --region ap-southeast-1 \
  --query "LoadBalancers[?DNSName=='${ALB_DNS}'].CanonicalHostedZoneId" \
  --output text)

cat > /tmp/r53-alias.json <<EOF
{
  "Comment": "litellm-sg → ALB",
  "Changes": [{
    "Action": "UPSERT",
    "ResourceRecordSet": {
      "Name": "litellm-sg.<your-domain>",
      "Type": "A",
      "AliasTarget": {
        "HostedZoneId": "${ALB_HZ}",
        "DNSName": "${ALB_DNS}",
        "EvaluateTargetHealth": false
      }
    }
  }]
}
EOF

aws route53 change-resource-record-sets \
  --hosted-zone-id <HOSTED_ZONE_ID> \
  --change-batch file:///tmp/r53-alias.json
```

**验证**(等 ~30 秒 DNS 生效):
```bash
dig +short litellm-sg.<your-domain>
# 应返回 ALB 的 IP(几个 IP 轮询)

curl -sk -o /dev/null -w "%{http_code}\n" https://litellm-sg.<your-domain>/health/liveliness
# 应返回 200(LiteLLM 健康检查)
```

---

## ② 填 Secrets — SALT key + Cognito client secret + Mantle key

LitellmConfigSecret 模板里有几个 `CHANGE_ME` 占位符,需要填真实值才能让 LiteLLM 启动、SSO 和 Mantle 模型工作。

> ⚠️ **关键时序问题(必读,别踩坑)**
>
> `cdk deploy` 完成后,LiteLLM Pod 已经在用**初始 `CHANGE_ME` 值**跑了。本步骤改 SecretsManager 后:
> 1. ExternalSecrets Operator(ESO)会在下次 refresh(默认 1h)自动同步到 K8s Secret —— 这部分你不用管
> 2. **但 Pod 通过 `envFrom` 注入的环境变量在 Pod 启动时一次性读取,K8s Secret 后续更新不会自动注入到正在运行的 Pod**
> 3. **必须显式 rollout restart Pod**(见 2.7),否则 Pod 内的 `GENERIC_CLIENT_ID` 等环境变量永远是 `CHANGE_ME`
>
> **症状**:浏览器打开 `/ui/` → 跳到 Cognito → URL 里出现 `client_id=CHANGE_ME` → 报 `invalid_request`
>
> **修复**:跑 2.7 的 `kubectl rollout restart deployment/litellm -n litellm`,完事就好

> 🔑 **SALT 不在这批 `CHANGE_ME` 里**。SALT 是一个**独立的 secret**(`<region>-litellm/salt`),且必须在 **deploy 之前**就建好(见 2.1),不是 post-deploy 往 `config` secret 里填。下表的 `config` secret 字段**不含** SALT。

**`config` secret 最小必填集**(只用 Bedrock Claude 时):
| 字段 | 是否必填 | 说明 |
|---|---|---|
| `GENERIC_CLIENT_ID` | ✅ 必填(走 SSO) | Cognito UserPoolClient ID |
| `GENERIC_CLIENT_SECRET` | ✅ 必填(走 SSO) | Cognito UserPoolClient Secret |
| `BEDROCK_MANTLE_API_KEY` | ⏸️ 可跳 | 只用 Claude 不用填,留 `CHANGE_ME`;调 GPT-5.5/5.4 才报 401 |
| `GEMINI_API_KEY` | ⏸️ 可跳 | 同上,只在调 Gemini 时需要 |
| `UI_PASSWORD` | ⏸️ 可跳 | 走 Cognito SSO 后这个不再用 |

### 2.1 创建 SALT secret(**deploy 前**,独立 secret,不是填 config)

`LITELLM_SALT_KEY` 是 LiteLLM 对称加密数据库里虚拟 key/provider 凭证的密钥。CDK **故意不创建**它(`lib/data-stack.ts` 用 `fromSecretNameV2` 只引用),`deploy.sh`/`init-env` 也不会自动建。**必须在首次 `cdk deploy` 之前**手动创建,且是一个**独立的 secret** `<region>-litellm/salt`(代码读 `salt.LITELLM_SALT_KEY`,**不读** `config.LITELLM_SALT_KEY`)。

> ⚠️ **没建会静默失败**:`cdk synth`/`deploy` 不报错,但起 pod 时 ESO 同步 `salt.LITELLM_SALT_KEY` 失败 → litellm 拿不到 SALT。

```bash
SALT=$(openssl rand -hex 16)   # 32 字符,真随机
aws secretsmanager create-secret \
  --name "ap-southeast-1-litellm/salt" \
  --description "LiteLLM SALT key (encrypts DB-stored virtual keys; never rotate)" \
  --secret-string "{\"LITELLM_SALT_KEY\":\"$SALT\"}" \
  --region ap-southeast-1
# ⚠️ 立即把 $SALT 存到密码管理器(1Password/Keychain/Bitwarden 任选)
# ⚠️ 这个值丢了 = DB 里所有虚拟 key/provider 凭证报废,只能清库重建
# ⚠️ 一旦设定永不能改(改了所有已存 key 解不开)
```

> 下面 2.2–2.4 处理的是 `config` secret 里的 Cognito 等 `CHANGE_ME` 字段(post-deploy),**不含 SALT**。SALT 已在本步用独立 secret 建好。

### 2.2 拿 Cognito client secret

```bash
COGNITO_SECRET=$(aws cognito-idp describe-user-pool-client \
  --region ap-southeast-1 \
  --user-pool-id <USER_POOL_ID> \
  --client-id <COGNITO_CLIENT_ID> \
  --query 'UserPoolClient.ClientSecret' --output text)

echo "Cognito Client Secret: $COGNITO_SECRET"
```

### 2.3 把现有 secret 拉下来,改完再写回

```bash
# 拉下当前 secret
aws secretsmanager get-secret-value \
  --region ap-southeast-1 \
  --secret-id ap-southeast-1-litellm/config \
  --query SecretString --output text > /tmp/litellm-config.json

# 检查里面的占位符(注意:SALT 不在 config secret 里,已在 2.1 单独建好)
cat /tmp/litellm-config.json | python3 -m json.tool
# 关注以 CHANGE_ME 开头的字段:
#   GENERIC_CLIENT_ID         → 填 <COGNITO_CLIENT_ID>
#   GENERIC_CLIENT_SECRET     → 填 $COGNITO_SECRET
#   BEDROCK_MANTLE_API_KEY    → 填你的 Mantle API key (us-east-2),只用 Claude 可跳
#   GEMINI_API_KEY            → 填你的 Gemini API key,不用可跳
```

### 2.4 用 jq 写入 Cognito 两件套(SALT 不在此,见 2.1)

**方式 A:命令行一次性写入 Cognito client id/secret**:
```bash
jq --arg cid "<COGNITO_CLIENT_ID>" \
   --arg csec "$COGNITO_SECRET" \
   '.GENERIC_CLIENT_ID = $cid
    | .GENERIC_CLIENT_SECRET = $csec' \
   /tmp/litellm-config.json > /tmp/litellm-config-new.json

# 检查 diff,确认只动了这 2 个字段
diff /tmp/litellm-config.json /tmp/litellm-config-new.json
```

**方式 B:Mantle/Gemini key 手动编辑**(可选,机密外部凭证):
```bash
# 只在你需要调 GPT-5.5/5.4/Gemini 时才编辑
# 用 vim/nano 编辑 /tmp/litellm-config-new.json,填:
#   "BEDROCK_MANTLE_API_KEY": "你的真实 Mantle key"
#   "GEMINI_API_KEY": "你的真实 Gemini key"
vim /tmp/litellm-config-new.json
```

### 2.5 写回 Secrets Manager

```bash
aws secretsmanager update-secret \
  --region ap-southeast-1 \
  --secret-id ap-southeast-1-litellm/config \
  --secret-string file:///tmp/litellm-config-new.json

# 清理临时文件
rm /tmp/litellm-config.json /tmp/litellm-config-new.json
```

### 2.6 强制 LiteLLM pod 重启,加载新 secret(**必跑,跳过这步等于白填**)

> 这是 Step ② 真正生效的关键一步。`envFrom` 注入的环境变量只在 Pod 启动时读一次,改完 SecretsManager 不重启 Pod,Pod 内永远是 `CHANGE_ME`。

```bash
kubectl rollout restart deployment/litellm -n litellm
kubectl rollout status deployment/litellm -n litellm --timeout=5m
```

### 2.7 验证 Pod 拿到真值(强烈建议跑)

```bash
# 这三个值应该都是真值,任意一个还显示 CHANGE_ME 说明 2.6 没跑或 ESO 还没同步
kubectl exec -n litellm deploy/litellm -- printenv GENERIC_CLIENT_ID
kubectl exec -n litellm deploy/litellm -- printenv GENERIC_CLIENT_SECRET | head -c 20 && echo "..."
kubectl exec -n litellm deploy/litellm -- printenv LITELLM_SALT_KEY | head -c 20 && echo "..."

# 期望输出:
#   <COGNITO_CLIENT_ID>     ← GENERIC_CLIENT_ID
#   <真随机字符串前 20 位>...        ← GENERIC_CLIENT_SECRET
#   <你的 SALT 前 20 位>...          ← LITELLM_SALT_KEY
```

**如果还是 `CHANGE_ME`**,说明 ESO 还没把 SecretsManager 的更新同步到 K8s Secret(默认 refreshInterval=1h)。强制刷新:

```bash
# 强制 ESO 立即同步(annotate 触发 reconcile)
kubectl annotate externalsecret litellm-secrets -n litellm \
  force-sync=$(date +%s) --overwrite

# 等几秒钟再重启 pod
sleep 10
kubectl rollout restart deployment/litellm -n litellm
kubectl rollout status deployment/litellm -n litellm --timeout=5m

# 再次验证
kubectl exec -n litellm deploy/litellm -- printenv GENERIC_CLIENT_ID
```

---

## ③ SearXNG(应该不需要做任何事,只确认即可)

> **从 cluster-stack.ts 这次更新开始,CDK 已经把完整可启动的 settings.yml 写进 `searxng-config` ConfigMap**(包含非空 `secret_key` + 引擎列表),Deployment 也挂载到 `/etc/searxng/`。**第一次 `cdk deploy` 完成时 searxng 就应该是 Running**——这一步是**确认**用的,不是手工配置。
>
> 历史记录:这个文档早期版本要求"从美东 import + patch volumeMount + 注入 settings",那是因为旧版 CDK 只放了一行 placeholder 注释,导致 searxng 因 `Invalid settings.yml` 反复 CrashLoop。现在已修复,不需要那些步骤。

### 3.1 现状检查(必跑,2 分钟内出结论)

```bash
# A. ConfigMap 是否存在
kubectl get cm searxng-config -n litellm
# 期望: NAME=searxng-config DATA=1 AGE=...
# 如果报 not found → 走 3.2

# B. Pod 状态
kubectl get pod -n litellm -l app=searxng
# 期望: STATUS=Running READY=1/1
# 如果是 CrashLoopBackOff/Error → 走 3.3

# C. 实际能搜
kubectl exec -n litellm deploy/litellm -- python -c "
import urllib.request, json
r = urllib.request.urlopen('http://searxng:8080/search?q=aws+eks&format=json', timeout=10)
d = json.loads(r.read())
print('status:', r.status, 'results:', len(d.get('results', [])))
"
# 期望: status: 200 results: 50+
# 如果 status 不是 200 或 results 为 0 → 走 3.3
```

> **三项全过 → SearXNG 完全 OK,直接跳到 Step ④。**

### 3.2 ConfigMap 不存在时的修复(从美东导一份)

只在 3.1 A 报 `not found` 时跑。前提:本地 kubectl 配置里有美东 context。

```bash
# 拉美东 ConfigMap,清理掉绑定到原集群的 metadata
kubectl --context arn:aws:eks:us-east-1:<ACCOUNT_ID>:cluster/litellm-cluster \
  get cm searxng-config -n litellm -o yaml \
  | grep -v -E "uid:|resourceVersion:|creationTimestamp:|namespace: litellm" \
  > /tmp/searxng-config.yaml

# apply 到新加坡(显式 --context 防 kubectl 切错集群)
kubectl --context arn:aws:eks:ap-southeast-1:<ACCOUNT_ID>:cluster/litellm-cluster \
  apply -n litellm -f /tmp/searxng-config.yaml

# 重启 searxng 加载
kubectl rollout restart deployment/searxng -n litellm
kubectl rollout status deployment/searxng -n litellm --timeout=2m

# 回到 3.1 重测
```

### 3.3 Pod CrashLoop 时的排错(看日志找根因)

```bash
kubectl logs -n litellm -l app=searxng --tail=80
```

按报错关键词对照下表处理:

| 日志关键词 | 根因 | 修复 |
|---|---|---|
| `server.secret_key: The value has to be one of these types/values: str` | ConfigMap 里 `secret_key` 是空/null/未替换的占位符 | 见 **3.3.1** |
| `Invalid settings.yml` 但**前面没报 secret_key** | settings.yml 别的字段语法错 | `kubectl edit cm searxng-config -n litellm` 修语法,然后 `kubectl rollout restart deployment/searxng -n litellm` |
| `CreateContainerConfigError` / `MountVolume.SetUp failed` | ConfigMap 不存在 | 走 3.2 |

#### 3.3.1 secret_key 缺失修复

```bash
# 1. 看现状(确认确实是 secret_key 问题)
kubectl get cm searxng-config -n litellm -o jsonpath='{.data.settings\.yml}' \
  | grep -A1 "^server:" | grep secret_key
# 如果输出 secret_key: "" / null / !ENV ${...} → 需要修

# 2. 直接编辑 ConfigMap,把 secret_key 改成真值
kubectl edit cm searxng-config -n litellm
# 在 server: 块下,把 secret_key 那行改为:
#   secret_key: "litellm-searxng-secret-2026"
# (默认部署用的就是这个值,改成任意非空字符串都行;只用于 session 签名,不是高敏感凭证)
# 保存退出

# 3. 重启 + 验证
kubectl rollout restart deployment/searxng -n litellm
kubectl rollout status deployment/searxng -n litellm --timeout=2m

# 4. 回到 3.1 重测
```

### 3.4 不要被这些日志吓到(都是无害噪声)

跑 `kubectl logs -l app=searxng` 时下面这些行**不影响功能**,无需处理:

| 日志行 | 解释 |
|---|---|
| `chown: /etc/searxng/...: Read-only file system` | ConfigMap 挂载默认只读,searxng 启动 chown 失败但只是警告,后面照样 `Listening at :::8080` |
| `loading engine ahmia/torch failed: set engine to inactive` | Tor 引擎在 EKS 没网络可达,自动跳过 |
| `WARNING:searx.botdetection.config: missing config file: /etc/searxng/limiter.toml` | `limiter: false` 关了限流,这个文件本来就不需要 |

**只有 `Process granian-worker` traceback + `Unexpected exit from worker-1` 才是真崩**,看到这俩就回 3.3。

### 3.5 注意:litellm 镜像里没有 `curl`

文档前面/后面都用 `kubectl exec deploy/litellm -- curl ...` 测连通,在 litellm 容器里**会报 `exec: "curl": executable file not found`**。一律改用 python:

```bash
kubectl exec -n litellm deploy/litellm -- python -c "
import urllib.request
r = urllib.request.urlopen('http://searxng:8080/healthz', timeout=5)
print('HTTP', r.status)
"
```

---

## ④ Cognito 创建管理员用户

LiteLLM UI 走 Cognito SSO,需要先创建管理员账号。

### 4.1 创建用户(临时密码 + admin 组)

Cognito 不允许"建用户时直接给永久密码",必须用临时密码 → 首次登录强制改密。

```bash
ADMIN_EMAIL="you@example.com"   # 改成你的真实邮箱(也可以是任意字符串作为用户名)
ADMIN_TEMP_PWD="TempPwd!$(openssl rand -hex 4)"   # 临时密码,登录后必须改

# 4.1.1 创建用户
aws cognito-idp admin-create-user \
  --region ap-southeast-1 \
  --user-pool-id <USER_POOL_ID> \
  --username "$ADMIN_EMAIL" \
  --user-attributes Name=email,Value="$ADMIN_EMAIL" Name=email_verified,Value=true \
  --temporary-password "$ADMIN_TEMP_PWD" \
  --message-action SUPPRESS

# 4.1.2 加到 admin 组(LiteLLM 会把 admin 组映射成 proxy_admin 角色)
aws cognito-idp admin-add-user-to-group \
  --region ap-southeast-1 \
  --user-pool-id <USER_POOL_ID> \
  --username "$ADMIN_EMAIL" \
  --group-name admin

echo ""
echo "===== 管理员账号已创建 ====="
echo "用户名: $ADMIN_EMAIL"
echo "临时密码: $ADMIN_TEMP_PWD"
echo "首次登录会强制改密"
```

> **注**:如果 admin 组不存在(CDK 没建),先建一下:
> ```bash
> aws cognito-idp create-group --region ap-southeast-1 \
>   --user-pool-id <USER_POOL_ID> \
>   --group-name admin
> ```

### 4.2 首次登录改密码

打开 https://litellm-sg.<your-domain>/ui/(部署完 R53 alias 生效后能访问)→ 跳到 Cognito Hosted UI → 输入用户名 + 临时密码 → 系统强制改新密码 → 重定向回 LiteLLM UI。

---

## 全部完成后的验证清单

```bash
# 1. DNS 解析
dig +short litellm-sg.<your-domain>

# 2. 健康检查
curl -sk -o /dev/null -w "%{http_code}\n" https://litellm-sg.<your-domain>/health/liveliness
# 期望 200

# 3. pods 全 Ready
kubectl get pods -n litellm
# litellm 3/3, searxng 1/1

# 4. 用 master key 调一次模型(从 secret 里拿)
MASTER_KEY=$(aws secretsmanager get-secret-value \
  --region ap-southeast-1 \
  --secret-id ap-southeast-1-litellm/config \
  --query SecretString --output text | jq -r '.LITELLM_MASTER_KEY')

curl -s https://litellm-sg.<your-domain>/v1/messages \
  -H "x-api-key: $MASTER_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-6",
    "max_tokens": 50,
    "messages": [{"role":"user","content":"say hi in 5 words"}]
  }'
# 期望返回 JSON 含 content + usage

# 5. UI 登录(浏览器)
# https://litellm-sg.<your-domain>/ui/
# Cognito SSO → 用 4.1 创建的账号登录
```

---

## 常见问题

**Q1. ALB target health 一直 unhealthy**
- 看 ALB target group: `aws elbv2 describe-target-health --region ap-southeast-1 --target-group-arn $(aws elbv2 describe-target-groups --region ap-southeast-1 --query "TargetGroups[?contains(TargetGroupName,'litellm')].TargetGroupArn" --output text)`
- 通常是 litellm pod 还没 Ready 或 SG 没放通,等 pod 起来即可

**Q2. UI 登录跳到 Cognito 报 redirect_uri mismatch**
- Cognito UserPoolClient 的 callback URL 列表要包含 `https://litellm-sg.<your-domain>/sso/callback`
- 检查:`aws cognito-idp describe-user-pool-client --region ap-southeast-1 --user-pool-id <USER_POOL_ID> --client-id <COGNITO_CLIENT_ID> --query 'UserPoolClient.CallbackURLs'`
- CDK 应该已经配好,如果不对手动 update-user-pool-client

**Q3. UI 登录跳到 Cognito 报 `invalid_request` 且 URL 带 `client_id=CHANGE_ME`**
- **根因**:Step ② 改完 SecretsManager 后没 rollout restart litellm pod。`envFrom` 注入的环境变量只在 Pod 启动时读一次,不会随 K8s Secret 更新自动注入。
- **诊断**:`kubectl exec -n litellm deploy/litellm -- printenv GENERIC_CLIENT_ID`,如果返回 `CHANGE_ME` 就是这个问题
- **修复**:跑 Step ② 的 2.6 + 2.7,即 `kubectl rollout restart deployment/litellm -n litellm` 然后验证 `printenv` 输出真值
- **如果重启后还是 CHANGE_ME**:ESO 可能没同步,跑 `kubectl annotate externalsecret litellm-secrets -n litellm force-sync=$(date +%s) --overwrite` 强制 reconcile,等 10 秒再 rollout restart

**Q4. pod 起来但调模型返回 401 / model not found**
- 检查 secret 里 `BEDROCK_MANTLE_API_KEY` 是否还是 CHANGE_ME(只影响 GPT 系列;Bedrock Claude 用 IRSA 不需要 key)
- 检查 configmap 里的模型列表:`kubectl get cm litellm-config -n litellm -o jsonpath='{.data.config\.yaml}' | grep model_name`
