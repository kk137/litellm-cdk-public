#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { DataStack } from '../lib/data-stack';
import { ClusterStack } from '../lib/cluster-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
};

const clusterName = (app.node.tryGetContext('clusterName') as string) || 'litellm-cluster';
const projectName = (app.node.tryGetContext('projectName') as string) || 'litellm';
const litellmImage =
  (app.node.tryGetContext('litellmImage') as string) ||
  'ghcr.io/berriai/litellm-database:v1.84.3';

// Route53 / ACM / Cognito / Ingress host parameterization. Real values are
// supplied at synth/deploy via `-c domain=... -c hostedZoneId=...` (or a
// gitignored cdk.context.json). Defaults are intentionally non-real.
const domain = (app.node.tryGetContext('domain') as string) || 'example.com';
const hostedZoneId =
  (app.node.tryGetContext('hostedZoneId') as string) || 'ZZZZZZZZZZZZZ';

// WebSearch interception backend. Default 'searxng' (self-hosted, region-
// agnostic). Set `-c websearchBackend=agentcore` to use Amazon Bedrock
// AgentCore Web Search (us-east-1 gateway) via the custom callback. See
// agentcore-websearch-litellm/docs.
const websearchBackend =
  String(app.node.tryGetContext('websearchBackend')).toLowerCase() === 'agentcore'
    ? 'agentcore'
    : 'searxng';

// Per-team Bedrock cost attribution. Off by default. Enable with
// `-c enableBedrockCostAttribution=true`. Creates the exec role + ships the
// hook; the callback must still be activated in config to take effect.
const enableBedrockCostAttribution =
  String(app.node.tryGetContext('enableBedrockCostAttribution')).toLowerCase() ===
  'true';

// Bedrock model invocation logging → CloudWatch (metadata only). Off by default.
// Enable with `-c enableBedrockInvocationLogging=true`. Account+region-level
// setting; captures ALL Bedrock calls in the region. Pairs with the cost-
// attribution hook to give near-real-time per-team usage (requestMetadata.team).
const enableBedrockInvocationLogging =
  String(app.node.tryGetContext('enableBedrockInvocationLogging')).toLowerCase() ===
  'true';
const invocationLogRetentionDaysCtx = app.node.tryGetContext(
  'invocationLogRetentionDays',
);
const invocationLogRetentionDays = invocationLogRetentionDaysCtx
  ? Number(invocationLogRetentionDaysCtx)
  : undefined;

const network = new NetworkStack(app, `${projectName}-Network`, {
  env,
  clusterName,
  description: 'VPC, subnets, NAT, IGW for LiteLLM cluster',
});

const data = new DataStack(app, `${projectName}-Data`, {
  env,
  vpc: network.vpc,
  sharedNodeSecurityGroup: network.sharedNodeSecurityGroup,
  projectName,
  description: 'RDS Postgres, ElastiCache Redis, S3 logs, Secrets Manager',
});
data.addDependency(network);

const cluster = new ClusterStack(app, `${projectName}-Cluster`, {
  env,
  vpc: network.vpc,
  sharedNodeSecurityGroup: network.sharedNodeSecurityGroup,
  litellmSecret: data.litellmSecret,
  rdsSecret: data.rdsSecret,
  redisAuthSecret: data.redisAuthSecret,
  saltSecret: data.saltSecret,
  rdsSecurityGroup: data.rdsSecurityGroup,
  redisSecurityGroup: data.redisSecurityGroup,
  redisHost: data.redisHost,
  databaseName: data.databaseName,
  logsBucket: data.logsBucket,
  clusterName,
  projectName,
  litellmImage,
  domain,
  hostedZoneId,
  websearchBackend,
  enableBedrockCostAttribution,
  enableBedrockInvocationLogging,
  invocationLogRetentionDays,
  description: 'EKS cluster, IAM, Karpenter, Helm charts, k8s manifests',
});
cluster.addDependency(data);

cdk.Tags.of(app).add('Project', projectName);
cdk.Tags.of(app).add('ManagedBy', 'cdk');
cdk.Tags.of(app).add('auto-delete', 'no');

app.synth();
