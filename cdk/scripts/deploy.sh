#!/bin/bash
set -euo pipefail

#============================================================
# LiteLLM CDK — 分步部署脚本(对齐 ECS deploy-sin.sh 风格)
#
# 用法:
#   一键(全自动):
#   ./scripts/deploy.sh deploy-all --domain <domain>
#
#   分步(推荐,每步可停下检查):
#   ./scripts/deploy.sh init --domain <domain>   # ① 参数发现,生成 cdk.context.json
#   ./scripts/deploy.sh bootstrap                # ② CDK bootstrap(新加坡首次必跑)
#   ./scripts/deploy.sh deploy-network           # ③ VPC/Subnets/NAT
#   ./scripts/deploy.sh deploy-data              # ④ RDS/Redis/S3/Secrets
#   ./scripts/deploy.sh deploy-cluster           # ⑤ EKS/Karpenter/LiteLLM/Ingress
#   ./scripts/deploy.sh post                     # ⑥ 打印部署后手动步骤
#
#   运维:
#   ./scripts/deploy.sh diff                     # cdk diff --all
#   ./scripts/deploy.sh outputs                  # 打印各栈 Outputs
#   ./scripts/deploy.sh destroy                  # 逆序销毁
#
# 环境:
#   --domain <domain>      Route53 域名(必填,除非 --skip-init)
#   --region <region>      默认 ap-southeast-1(硬钉,防 us-east-1 环境污染)
#   --host-prefix <prefix> 默认 litellm
#   --max-azs <n>          NodePool/网络用几个 AZ(默认 2;生产 HA 可 3)
#   --skip-init            跳过 init-env,复用已有 cdk.context.json
#============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# 默认 region 硬钉新加坡,不从环境继承(防止 us-east-1 残留把资源建错区)
DEFAULT_REGION="ap-southeast-1"
DOMAIN=""
REGION="${DEFAULT_REGION}"
HOST_PREFIX="litellm"
ADMIN_PRINCIPALS=""
MAX_AZS=""
SKIP_INIT=""
PROJECT_NAME="litellm"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

#============================================================
# 参数解析(子命令后面的 flags)
#============================================================
CMD="${1:-help}"; shift || true

while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN="$2"; shift 2;;
    --region) REGION="$2"; shift 2;;
    --host-prefix) HOST_PREFIX="$2"; shift 2;;
    --admin-principals) ADMIN_PRINCIPALS="$2"; shift 2;;
    --max-azs) MAX_AZS="$2"; shift 2;;
    --skip-init) SKIP_INIT=1; shift;;
    -h|--help) CMD="help"; break;;
    *) log_error "Unknown option: $1"; exit 1;;
  esac
done

#============================================================
# 前置检查
#============================================================
check_prerequisites() {
    log_info "Checking prerequisites..."
    command -v aws >/dev/null || { log_error "AWS CLI not installed."; exit 1; }
    command -v npx >/dev/null || { log_error "npx not found (need Node.js)."; exit 1; }
    aws sts get-caller-identity >/dev/null || { log_error "AWS credentials not configured."; exit 1; }
    local acct; acct=$(aws sts get-caller-identity --query Account --output text)
    log_info "Account: ${acct} | Region: ${REGION} | Project: ${PROJECT_NAME}"
}

#============================================================
# init-env: 参数自动发现
#============================================================
do_init() {
    if [[ -z "$SKIP_INIT" ]]; then
        [[ -n "$DOMAIN" ]] || { log_error "--domain is required (or use --skip-init)"; exit 1; }
        log_info ">>> Step: Auto-discovering parameters (init-env)..."
        local INIT_ARGS="--domain $DOMAIN --region $REGION"
        [[ "$HOST_PREFIX" != "litellm" ]] && INIT_ARGS="$INIT_ARGS --host-prefix $HOST_PREFIX"
        [[ -n "$ADMIN_PRINCIPALS" ]] && INIT_ARGS="$INIT_ARGS --admin-principals '$ADMIN_PRINCIPALS'"
        [[ -n "$MAX_AZS" ]] && INIT_ARGS="$INIT_ARGS --max-azs $MAX_AZS"
        eval npx ts-node scripts/init-env.ts $INIT_ARGS
        cp cdk.context.local.json cdk.context.json
        log_info "cdk.context.json updated."
        log_info "下一步: ./scripts/deploy.sh bootstrap"
    else
        log_info ">>> Step: Skipped init (--skip-init). Using existing cdk.context.json."
    fi
}

#============================================================
# 分步部署前置校验:cdk.context.json 必须已由 init 生成
# (deploy-cluster 用到 domain/hostedZoneId 做 ACM/WAF/Cognito/Ingress;
#  没 init 过会用假默认值 example.com 部署出错的证书/路由)
#============================================================
require_context() {
    if [[ ! -f cdk.context.json ]]; then
        log_error "cdk.context.json 不存在。请先跑: ./scripts/deploy.sh init --domain <domain>"
        exit 1
    fi
    local dom
    dom=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('cdk.context.json','utf8')).domain||'')}catch(e){console.log('')}" 2>/dev/null)
    if [[ -z "$dom" || "$dom" == "example.com" ]]; then
        log_error "cdk.context.json 里 domain 无效($dom)。请重新跑: ./scripts/deploy.sh init --domain <domain>"
        exit 1
    fi
    log_info "Context OK: domain=${dom}"
}

#============================================================
# CDK 环境设置
#============================================================
setup_cdk_env() {
    if [[ -f cdk.context.json ]]; then
        local ctx_region
        ctx_region=$(node -e "console.log(JSON.parse(require('fs').readFileSync('cdk.context.json','utf8')).bedrockRegion || '${REGION}')")
        export CDK_DEFAULT_REGION="${ctx_region}"
    else
        export CDK_DEFAULT_REGION="${REGION}"
    fi
    export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text --region "$CDK_DEFAULT_REGION")
    export AWS_REGION="$CDK_DEFAULT_REGION"
    export AWS_DEFAULT_REGION="$CDK_DEFAULT_REGION"
    log_info "CDK env: Account=${CDK_DEFAULT_ACCOUNT} Region=${CDK_DEFAULT_REGION}"
}

#============================================================
# Bootstrap
#============================================================
do_bootstrap() {
    log_info ">>> CDK bootstrap (idempotent)..."
    npx cdk bootstrap "aws://$CDK_DEFAULT_ACCOUNT/$CDK_DEFAULT_REGION"
    log_info "bootstrap done. 下一步: ./scripts/deploy.sh deploy-network"
}

#============================================================
# 分步部署
#============================================================
deploy_network() {
    log_info ">>> Deploying ${PROJECT_NAME}-Network..."
    npx cdk deploy "${PROJECT_NAME}-Network" --require-approval never
    log_info "${PROJECT_NAME}-Network done."
    log_info "下一步: ./scripts/deploy.sh deploy-data"
}

deploy_data() {
    log_info ">>> Deploying ${PROJECT_NAME}-Data..."
    npx cdk deploy "${PROJECT_NAME}-Data" --require-approval never
    log_info "${PROJECT_NAME}-Data done."
    log_info "下一步: ./scripts/deploy.sh deploy-cluster"
}

deploy_cluster() {
    log_info ">>> Deploying ${PROJECT_NAME}-Cluster..."
    npx cdk deploy "${PROJECT_NAME}-Cluster" --require-approval never
    log_info "${PROJECT_NAME}-Cluster done."
    log_info "下一步: ./scripts/deploy.sh post"
}

#============================================================
# deploy-all: 全自动(init → bootstrap → network → data → cluster)
#============================================================
deploy_all() {
    log_info "=== 全新部署(全自动)==="
    do_init
    setup_cdk_env
    do_bootstrap
    deploy_network
    deploy_data
    deploy_cluster
    log_info "=== 全部栈部署完成 ==="
    do_post
}

#============================================================
# diff
#============================================================
do_diff() {
    setup_cdk_env
    log_info ">>> cdk diff --all..."
    npx cdk diff --all
}

#============================================================
# outputs: 打印各栈 Outputs
#============================================================
do_outputs() {
    setup_cdk_env
    local region="$CDK_DEFAULT_REGION"
    for stack in "${PROJECT_NAME}-Network" "${PROJECT_NAME}-Data" "${PROJECT_NAME}-Cluster"; do
        log_info "--- ${stack} ---"
        aws cloudformation describe-stacks --stack-name "${stack}" --region "${region}" \
            --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' --output table 2>/dev/null || echo "  (not deployed)"
    done
}

#============================================================
# post: 自动化部署后步骤(幂等)
#   ① Route53 A-alias  ② Cognito client secret 写回  ③ admin 用户
#   ④ rollout restart litellm + 验证
# 仍需人手工的只剩:Mantle/Gemini key(外部凭证)、SearXNG(CDK 已内置,通常无需动)
#============================================================

# 从 CFN 栈 output 取单个值
stack_output() {
    local stack="$1" key="$2"
    aws cloudformation describe-stacks --stack-name "$stack" --region "$REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='${key}'].OutputValue|[0]" \
        --output text 2>/dev/null
}

# ① Route53 A-alias → ALB(从 ingress 读 ALB DNS,运行时才知道)
post_route53() {
    log_info ">>> ① Route53 A-alias..."
    local hz uiHost albDns albHz
    hz=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('cdk.context.json','utf8')).hostedZoneId||'')}catch(e){console.log('')}" 2>/dev/null)
    uiHost=$(stack_output "${PROJECT_NAME}-Cluster" "UiHost")
    # UiHost 不一定有 output;回退用 host-prefix + domain 拼
    [[ -z "$uiHost" || "$uiHost" == "None" ]] && uiHost="${HOST_PREFIX}.$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('cdk.context.json','utf8')).domain)}catch(e){console.log('')}" 2>/dev/null)"

    albDns=$(kubectl get ingress -n litellm litellm \
        -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null)
    if [[ -z "$albDns" ]]; then
        log_warn "   ingress 还没拿到 ALB DNS(ALB 可能还在 provisioning)。稍后重跑: $0 post"
        return 0
    fi
    if [[ -z "$hz" ]]; then
        log_warn "   cdk.context.json 缺 hostedZoneId,跳过 Route53。手动建: $uiHost ALIAS-> $albDns"
        return 0
    fi
    albHz=$(aws elbv2 describe-load-balancers --region "$REGION" \
        --query "LoadBalancers[?DNSName=='${albDns}'].CanonicalHostedZoneId|[0]" --output text 2>/dev/null)
    [[ -z "$albHz" || "$albHz" == "None" ]] && { log_warn "   取不到 ALB CanonicalHostedZoneId,跳过。"; return 0; }

    cat > /tmp/r53-alias.json <<EOF
{"Comment":"litellm A-alias","Changes":[{"Action":"UPSERT","ResourceRecordSet":{
"Name":"${uiHost}","Type":"A","AliasTarget":{"HostedZoneId":"${albHz}","DNSName":"${albDns}","EvaluateTargetHealth":false}}}]}
EOF
    aws route53 change-resource-record-sets --hosted-zone-id "$hz" \
        --change-batch file:///tmp/r53-alias.json >/dev/null \
        && log_info "   ✅ ${uiHost} -> ${albDns}" \
        || log_warn "   Route53 UPSERT 失败(权限?手动建)"
    rm -f /tmp/r53-alias.json
}

# ② Cognito client secret 写回 config secret(generateSecret 的 secret 只能 API 取)
post_cognito_secret() {
    log_info ">>> ② Cognito client id/secret 写回 SecretsManager..."
    local cfgSecret upid clientId clientSecret
    cfgSecret=$(stack_output "${PROJECT_NAME}-Data" "LitellmSecretName")
    upid=$(stack_output "${PROJECT_NAME}-Cluster" "UserPoolId")
    clientId=$(stack_output "${PROJECT_NAME}-Cluster" "UserPoolClientId")
    if [[ -z "$cfgSecret" || -z "$upid" || -z "$clientId" || "$cfgSecret" == "None" ]]; then
        log_warn "   缺 outputs(cfgSecret/UserPoolId/ClientId),跳过。"
        return 0
    fi
    clientSecret=$(aws cognito-idp describe-user-pool-client --region "$REGION" \
        --user-pool-id "$upid" --client-id "$clientId" \
        --query 'UserPoolClient.ClientSecret' --output text 2>/dev/null)
    [[ -z "$clientSecret" || "$clientSecret" == "None" ]] && { log_warn "   取不到 client secret,跳过。"; return 0; }

    aws secretsmanager get-secret-value --region "$REGION" --secret-id "$cfgSecret" \
        --query SecretString --output text > /tmp/cfg.json 2>/dev/null || { log_warn "   读 config secret 失败"; return 0; }
    # 幂等:已是真值就不重写
    local cur; cur=$(python3 -c "import json;print(json.load(open('/tmp/cfg.json')).get('GENERIC_CLIENT_ID',''))" 2>/dev/null)
    if [[ "$cur" == "$clientId" ]]; then
        log_info "   already set,跳过。"; rm -f /tmp/cfg.json; return 0
    fi
    CLIENT_ID="$clientId" CLIENT_SECRET="$clientSecret" python3 - <<'PY' > /tmp/cfg-new.json
import json, os
d = json.load(open('/tmp/cfg.json'))
d['GENERIC_CLIENT_ID'] = os.environ['CLIENT_ID']
d['GENERIC_CLIENT_SECRET'] = os.environ['CLIENT_SECRET']
print(json.dumps(d))
PY
    aws secretsmanager update-secret --region "$REGION" --secret-id "$cfgSecret" \
        --secret-string file:///tmp/cfg-new.json >/dev/null \
        && log_info "   ✅ GENERIC_CLIENT_ID/SECRET 已写回" \
        || log_warn "   update-secret 失败"
    rm -f /tmp/cfg.json /tmp/cfg-new.json
}

# ③ Cognito admin 用户(临时密码,首次登录强制改)
post_admin_user() {
    log_info ">>> ③ Cognito admin 用户..."
    local upid; upid=$(stack_output "${PROJECT_NAME}-Cluster" "UserPoolId")
    [[ -z "$upid" || "$upid" == "None" ]] && { log_warn "   缺 UserPoolId,跳过。"; return 0; }
    local user="${ADMIN_USER:-admin}"
    # 幂等:已存在就不重建
    if aws cognito-idp admin-get-user --region "$REGION" --user-pool-id "$upid" \
        --username "$user" >/dev/null 2>&1; then
        log_info "   用户 '$user' 已存在,跳过创建。如需重置密码: aws cognito-idp admin-set-user-password ..."
        return 0
    fi
    # admin 组不存在则建(CDK 没建组时兜底)
    aws cognito-idp get-group --region "$REGION" --user-pool-id "$upid" --group-name admin >/dev/null 2>&1 \
        || aws cognito-idp create-group --region "$REGION" --user-pool-id "$upid" --group-name admin >/dev/null 2>&1 || true

    local tmpPwd="TempPwd!$(openssl rand -hex 4)"
    aws cognito-idp admin-create-user --region "$REGION" --user-pool-id "$upid" \
        --username "$user" \
        --user-attributes Name=email_verified,Value=true \
        --temporary-password "$tmpPwd" --message-action SUPPRESS >/dev/null 2>&1 \
        && aws cognito-idp admin-add-user-to-group --region "$REGION" --user-pool-id "$upid" \
            --username "$user" --group-name admin >/dev/null 2>&1 \
        && { log_info "   ✅ 已创建 admin 用户"; echo "      用户名: $user"; echo "      临时密码: $tmpPwd (首次登录强制改密)"; } \
        || log_warn "   创建 admin 用户失败(权限?手动建)"
}

# ④ rollout restart + 验证 pod 拿到真值
post_restart_verify() {
    log_info ">>> ④ rollout restart litellm + 验证..."
    kubectl rollout restart deployment/litellm -n litellm >/dev/null 2>&1 || { log_warn "   rollout restart 失败"; return 0; }
    kubectl rollout status deployment/litellm -n litellm --timeout=5m >/dev/null 2>&1 || log_warn "   rollout 未在 5m 内完成"
    local cid; cid=$(kubectl exec -n litellm deploy/litellm -- printenv GENERIC_CLIENT_ID 2>/dev/null)
    if [[ -n "$cid" && "$cid" != "CHANGE_ME" ]]; then
        log_info "   ✅ pod GENERIC_CLIENT_ID = $cid"
    else
        log_warn "   pod 内 GENERIC_CLIENT_ID 仍是 '$cid'。可能 ESO 未同步,强制刷新:"
        log_warn "     kubectl annotate externalsecret litellm-secrets -n litellm force-sync=\$(date +%s) --overwrite && sleep 10 && kubectl rollout restart deployment/litellm -n litellm"
    fi
}

do_post() {
    setup_cdk_env
    echo ""
    log_info "============================================"
    log_info "自动化部署后步骤(幂等,可重复跑)"
    log_info "============================================"
    post_route53
    post_cognito_secret
    post_admin_user
    post_restart_verify
    echo ""
    log_info "============================================"
    log_info "仍需人手工(外部凭证,可选):"
    echo "  - BEDROCK_MANTLE_API_KEY (调 GPT-5.5/5.4 才需要)"
    echo "  - GEMINI_API_KEY (调 Gemini 才需要)"
    echo "  填法: aws secretsmanager update-secret --region $REGION --secret-id <region>-litellm/config ..."
    echo "  填完重启: kubectl rollout restart deployment/litellm -n litellm"
    log_info "============================================"
    local host="${HOST_PREFIX}.$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('cdk.context.json','utf8')).domain)}catch(e){console.log('your-domain.com')}" 2>/dev/null)"
    log_info "UI: https://${host}/ui/"
    echo ""
}

#============================================================
# destroy: 逆序销毁(带确认)
#============================================================
do_destroy() {
    setup_cdk_env
    log_warn "将逆序销毁全部栈: Cluster → Data → Network"
    read -p "确定? (y/N): " c; [[ "${c}" =~ ^[Yy]$ ]] || { log_info "已取消。"; return 0; }
    log_info "Destroying ${PROJECT_NAME}-Cluster..."
    npx cdk destroy "${PROJECT_NAME}-Cluster" --force || true
    log_info "Destroying ${PROJECT_NAME}-Data..."
    npx cdk destroy "${PROJECT_NAME}-Data" --force || true
    log_info "Destroying ${PROJECT_NAME}-Network..."
    npx cdk destroy "${PROJECT_NAME}-Network" --force || true
    log_warn "提醒: RDS 有 DeletionProtection/SNAPSHOT 策略,可能需要手动处理。"
}

#============================================================
# help
#============================================================
usage() {
    cat <<EOF
Usage: $0 <command> [options]

一键(全自动):
  deploy-all              init→bootstrap→network→data→cluster

分步(按顺序跑,每步可停下检查):
  init --domain <domain>  ① 参数发现,生成 cdk.context.json
  bootstrap               ② CDK bootstrap(新加坡首次必跑)
  deploy-network          ③ Network 栈(VPC/Subnets/NAT)
  deploy-data             ④ Data 栈(RDS/Redis/S3/Secrets)
  deploy-cluster          ⑤ Cluster 栈(EKS/Karpenter/LiteLLM/Ingress)
  post                    ⑥ 打印部署后手动步骤

Ops:
  diff                    cdk diff --all(查看变更)
  outputs                 打印各栈 Outputs(ALB DNS/RDS endpoint 等)
  destroy                 逆序销毁全部栈(带确认)

Options:
  --domain <domain>       Route53 域名(init 必填)
  --region <region>       AWS 区域(默认 ${DEFAULT_REGION})
  --host-prefix <prefix>  子域名前缀(默认 litellm)
  --max-azs <n>           NodePool/网络 AZ 数(默认 2,生产 HA 可 3)
  --admin-principals <json>  IAM ARN 列表(kubectl 访问)
  --skip-init             init 子命令专用:跳过发现,复用已有 cdk.context.json

分步部署示例:
  $0 init --domain <your-domain>
  $0 bootstrap
  $0 deploy-network
  $0 deploy-data
  $0 deploy-cluster
  $0 post

一键示例:
  $0 deploy-all --domain <your-domain>
EOF
}

#============================================================
# 主入口
#============================================================
main() {
    case "${CMD}" in
        deploy-all|deploy)     check_prerequisites; deploy_all ;;
        bootstrap)             check_prerequisites; require_context; setup_cdk_env; do_bootstrap ;;
        deploy-network)        check_prerequisites; require_context; setup_cdk_env; deploy_network ;;
        deploy-data)           check_prerequisites; require_context; setup_cdk_env; deploy_data ;;
        deploy-cluster)        check_prerequisites; require_context; setup_cdk_env; deploy_cluster ;;
        init)                  check_prerequisites; do_init ;;
        diff)                  check_prerequisites; do_diff ;;
        outputs)               check_prerequisites; do_outputs ;;
        post)                  do_post ;;
        destroy)               check_prerequisites; do_destroy ;;
        help|--help|-h)        usage ;;
        *) log_error "Unknown command: ${CMD}"; usage; exit 1 ;;
    esac
}

main
