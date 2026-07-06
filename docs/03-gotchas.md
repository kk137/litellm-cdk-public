# CDK 部署踩坑总表 (gotchas)

> 占位符提示:`<ACCOUNT_ID>` / `<AGENTCORE_GATEWAY_ID>` 等请替换成你自己账号的真实值;示例 region 用 `ap-southeast-1`,换成你的 region。
> 入库文档,跨会话/跨机器可读,不依赖本机 Claude memory。
> 配套:`docs/01-prerequisites-and-deploy.md`、`docs/02-post-deploy-steps.md`。

---

## 1. cdk diff/deploy 必须在同一条命令里钉死 region

`bin/litellm-cdk.ts` 的 env region 是 `process.env.CDK_DEFAULT_REGION || 'us-east-1'`。本机 shell 实际 region 常是别的(如 us-west-2),且 **shell env 不跨 Bash 调用持久**。若不在同一条命令里设 region,CDK 回落 bin 默认 `us-east-1` → 对一个**空的/不存在的 us-east-1 stack** 做 diff → 显示全 `[+]`(假象,看着像要重建整个栈)。

正确(一条命令带全):
```bash
AWS_REGION=<REGION> AWS_DEFAULT_REGION=<REGION> \
CDK_DEFAULT_REGION=<REGION> CDK_DEFAULT_ACCOUNT=<ACCOUNT_ID> \
npx cdk diff litellm-Cluster
```
判断有没有钉对:看 `Publishing ... Template (<ACCOUNT_ID>-<REGION>-...)`。出现非预期 region 就是钉错了。对已部署的栈,正确结果应是 `There were no differences`。

## 2. 启用可选特性时,deploy 必带对应 flag,否则摧毁那些资源

可选特性(AgentCore websearch、成本归因)是 opt-in flag 控制的;**启用过后再 deploy 漏掉 flag = cdk 认为要删它们**。把 flag 写进 `cdk.context.json`(`deploy.sh` 读它),或直接 `npx cdk deploy` 手动带全:
```
-c websearchBackend=agentcore
-c enableBedrockCostAttribution=true   # 若已启用 per-team 归因
```

## 3. routine 镜像升级不要碰 secret

config secret 重置成 CHANGE_ME **只发生在 stack 首次 create**(generateSecretString)。日常改 image tag 不会动它。v1.90 升级回滚那次误以为 secret 被重置去手动改,是多余动作。

## 4. 升级 = 4 回归风险,先读文档别凭记忆

v1.84.3 → 1.90 引入 4 个回归(websearch 多轮 srvtoolu_ 400 / MCP env_vars 列缺 / Cognito CHANGE_ME / DB schema 落后)全部回滚。教训:升级前先读 post-deploy/rollback/gotchas 文档;别凭记忆断言版本;别把可复现行为说成"明确 bug"除非有 issue ID(srvtoolu_ 后来确实是上游回归,issue #31569)。`cdk deploy` 不跑 prisma migrate,DB schema 不会自动跟上新版本。

## 5. configmap 变更不会自动重启 pod

EKS 上 litellm config 挂成 configmap volume,LiteLLM 只在**启动时读 config.yaml**。`cdk deploy` 改了 configmap 内容,pod 不会自动重启,**仍跑旧 config**。改完要手动:
```bash
kubectl rollout restart deployment/litellm -n litellm
kubectl rollout status  deployment/litellm -n litellm --timeout=200s
```

## 6. per-team Bedrock 归因 hook:别用 startswith("bedrock/") 判断 (bug-027)

`bedrock-cost-attribution/src/bedrock_team_tag_hook.py` 的 `async_pre_call_hook` 里,`data["model"]` 是**公开 model_name**(如 `bedrock-nova-pro`),不是 `bedrock/...`,且 `custom_llm_provider` 未解析。早期版本用 `model.startswith("bedrock/")` gate → 永远 early-return → **静默零归因**(请求照常走 pod IRSA,成功路径不打日志,极难发现)。修法:对所有有 team_alias 的请求都注入临时凭证(非 bedrock 后端忽略 aws_* key,无害)。验证机制:base_aws_llm.py 的 aws_authentication_params 认 aws_access_key_id;proxy/utils.py pre_call_hook 返回值经 process_pre_call_hook_response 写回 data。激活=把 `bedrock_team_tag_hook.bedrock_team_tag_hook_instance` 加进 config.yaml callbacks(model-config-builder.ts 里也 gated 在同 flag)。

## 7. agentcore websearch 是否真触发,看 gateway 自己的 CloudWatch 日志

LiteLLM 侧看不到搜索执行(`_execute_search` 用 verbose_logger.debug,而 LITELLM_LOG=INFO 滤掉 DEBUG);CloudTrail 也无(数据面不进 management events)。真相在:
```
/aws/vendedlogs/bedrock-agentcore/gateway/APPLICATION_LOGS/<AGENTCORE_GATEWAY_ID>  (us-east-1)
```
每次真实搜索是一条 `method=tools/call, params={name=web-search-tool___WebSearch, arguments={query=...}}`。`initialize`/`tools/list` 只是 MCP 握手。

## 8. SALT secret 必须 deploy 前手建,否则 pod 静默起不来

`LITELLM_SALT_KEY` 加密 DB 里的虚拟 key,一旦设定永不能改。因此 CDK **故意不创建**它(`data-stack.ts` 用 `fromSecretNameV2` 只引用,避免 CFN 替换 brick 掉 DB key),`deploy.sh`/`init-env` 也不自动建。

- **必须在首次 `cdk deploy` 之前**手动创建一个**独立 secret** `<region>-litellm/salt`,JSON 键名 `LITELLM_SALT_KEY`:
  ```bash
  SALT=$(openssl rand -hex 16)
  aws secretsmanager create-secret --name "<REGION>-litellm/salt" \
    --secret-string "{\"LITELLM_SALT_KEY\":\"$SALT\"}" --region <REGION>
  # 备份 $SALT;丢了 = DB 里所有 key 报废
  ```
- **不是**填进 `config` secret 的字段——代码读 `salt.LITELLM_SALT_KEY`(独立 secret),不读 `config.LITELLM_SALT_KEY`。
- **没建 = 静默失败**:`cdk synth`/`deploy` 不报错(`fromSecretNameV2` 不校验存在性),起 pod 时 ESO 同步 `salt.LITELLM_SALT_KEY` 失败,litellm 拿不到 SALT。
- 现网验证:secret 的 CreatedDate 应是手动 create 的时间点,而非 CFN 栈创建时间(若是后者说明被 CDK 接管了,有 brick 风险)。
- 历史教训:`02-post-deploy-steps.md` / `01-prerequisites-and-deploy.md` 曾错写"CDK 自动生成 SALT",且把 SALT 教成填进 config secret——两处都已修正为"deploy 前建独立 /salt secret"。
