import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { KubectlV35Layer } from '@aws-cdk/lambda-layer-kubectl-v35';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import * as fs from 'fs';
import * as path from 'path';
import { buildLitellmConfig } from './helpers/model-config-builder';

export interface ClusterStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly sharedNodeSecurityGroup: ec2.ISecurityGroup;
  readonly litellmSecret: secretsmanager.ISecret;
  readonly rdsSecret: secretsmanager.ISecret;
  readonly redisAuthSecret: secretsmanager.ISecret;
  readonly saltSecret: secretsmanager.ISecret;
  readonly rdsSecurityGroup: ec2.ISecurityGroup;
  readonly redisSecurityGroup: ec2.ISecurityGroup;
  readonly redisHost: string;
  readonly databaseName: string;
  readonly logsBucket: s3.IBucket;
  readonly clusterName: string;
  readonly projectName: string;
  readonly litellmImage: string;
  /** Apex DNS zone (e.g. example.com). UI host is litellm.<domain>. */
  readonly domain: string;
  /** Route53 hosted zone id for <domain> (in-account). */
  readonly hostedZoneId: string;
  /**
   * WebSearch interception backend. 'searxng' (default) uses the built-in
   * callback → self-hosted SearXNG. 'agentcore' uses a custom callback subclass
   * (agentcore_websearch.py, shipped in the litellm-config ConfigMap) that calls
   * Amazon Bedrock AgentCore Web Search. AgentCore gateway is us-east-1 only.
   */
  readonly websearchBackend?: 'searxng' | 'agentcore';
  /**
   * Enable per-team Bedrock cost attribution. Creates a `litellm-bedrock-exec`
   * role, grants litellm-sa sts:AssumeRole+TagSession into it, and ships the
   * bedrock_team_tag_hook.py callback (assumes the exec role per team with an
   * STS session tag `team=<alias>` so CUR 2.0 surfaces iamPrincipal/team).
   * Off by default — turning it on routes Bedrock calls through AssumeRole.
   */
  readonly enableBedrockCostAttribution?: boolean;
}

/**
 * EKS cluster + IAM (Karpenter / aws-lbc / external-secrets IRSA)
 *   + Helm charts (external-secrets / aws-lbc / Karpenter)
 *   + k8s manifests (litellm namespace, configmap, deploy, svc, ing,
 *     hpa, pdb, ESO ClusterSecretStore + ExternalSecret, EC2NodeClass,
 *     NodePool).
 *
 * Replicates source terraform/{eks,karpenter,secrets-manager}.tf
 * and the litellm k8s manifests.
 *
 * Deploy order (CDK dependencies handle this):
 *   1. EKS cluster + OIDC provider
 *   2. MNG (system nodes, t3.medium x2 + CriticalAddonsOnly taint)
 *   3. AwsCustomResource: tag MNG ASG with auto-delete=no propagated
 *      (EKS does not propagate nodegroup-level tags to ASG/EC2)
 *   4. AwsCustomResource: tag cluster SG with karpenter.sh/discovery
 *      (cluster SG is EKS-managed, not CDK-owned)
 *   5. IRSA roles + Karpenter node role + access entry
 *   6. Helm: external-secrets, aws-lbc, karpenter (parallel-ish; CDK
 *      sequences via dependencies)
 *   7. Manifests: namespace, ESO store, configmap, deploy, svc, ing,
 *      hpa, pdb, EC2NodeClass, NodePool — each with addDependency on
 *      the controller that owns its CRDs
 */
export class ClusterStack extends cdk.Stack {
  public readonly cluster: eks.Cluster;
  /** Set when enableBedrockCostAttribution; injected as BEDROCK_EXEC_ROLE_ARN. */
  public bedrockExecRoleArn?: string;

  constructor(scope: Construct, id: string, props: ClusterStackProps) {
    super(scope, id, props);

    // ============================================================
    // 1. EKS cluster
    // ============================================================
    const cluster = new eks.Cluster(this, 'Cluster', {
      version: eks.KubernetesVersion.V1_35,
      kubectlLayer: new KubectlV35Layer(this, 'KubectlLayer'),
      clusterName: props.clusterName,
      vpc: props.vpc,
      vpcSubnets: [
        { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        { subnetType: ec2.SubnetType.PUBLIC },
      ],
      defaultCapacity: 0,
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
      authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
      securityGroup: props.sharedNodeSecurityGroup as ec2.SecurityGroup,
    });
    this.cluster = cluster;

    // The app-level `Tags.of(app).add('auto-delete','no')` does NOT propagate
    // onto the EKS control plane itself — this CDK version creates the cluster
    // via a custom resource (Custom::AWSCDK-EKS-Cluster), not a native
    // AWS::EKS::Cluster, so neither global tags nor Tags.of(defaultChild)
    // reach the cluster ARN. The account's nuke/reaper checks the tag ON the
    // cluster ARN, so inject it into the custom resource's Config.tags map
    // directly (this is what lands on the EKS control plane, mirroring how the
    // us-east-1 eksctl cluster carries auto-delete=no on its ControlPlane).
    const clusterResource = cluster.node
      .findAll()
      .find(
        (c) =>
          (c as cdk.CfnResource).cfnResourceType ===
          'Custom::AWSCDK-EKS-Cluster',
      ) as cdk.CfnResource | undefined;
    if (clusterResource) {
      clusterResource.addPropertyOverride('Config.tags', {
        'auto-delete': 'no',
        Project: props.projectName,
        ManagedBy: 'cdk',
      });
    }

    // EKS managed nodegroup uses the EKS auto-created cluster SG (eks-cluster-sg-*),
    // NOT props.sharedNodeSecurityGroup. RDS/Redis SG ingress from sharedNodeSG alone
    // can't reach pods. Authorize the cluster SG explicitly.
    //
    // Ingress rules are created as standalone CfnSecurityGroupIngress resources
    // in this (cluster) stack to avoid a Data->Cluster cyclic reference: the SG
    // belongs to DataStack but the source is the cluster SG defined here.
    new ec2.CfnSecurityGroupIngress(this, 'RdsIngressFromClusterSg', {
      groupId: props.rdsSecurityGroup.securityGroupId,
      sourceSecurityGroupId: cluster.clusterSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      description: 'Postgres from EKS cluster SG (auto-created by EKS for managed nodegroup)',
    });
    new ec2.CfnSecurityGroupIngress(this, 'RedisIngressFromClusterSg', {
      groupId: props.redisSecurityGroup.securityGroupId,
      sourceSecurityGroupId: cluster.clusterSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 6379,
      toPort: 6379,
      description: 'Redis from EKS cluster SG (auto-created by EKS for managed nodegroup)',
    });

    // Grant kubectl access to named admin principals. Without this, anyone
    // other than the cluster creator role (the role that ran `cdk deploy`)
    // gets "the server has asked for the client to provide credentials".
    // Default is empty — deployer MUST pass their own principal(s) via:
    //   -c clusterAdminPrincipals='["arn:aws:iam::<acct>:user/foo"]'
    // (We do NOT bake a foreign username default into the template.)
    // Context arriving via `-c` is a JSON string; arriving via cdk.json it
    // is already an array. Normalize both forms.
    const rawAdminPrincipals = this.node.tryGetContext('clusterAdminPrincipals');
    let adminPrincipals: string[] = [];
    if (Array.isArray(rawAdminPrincipals)) {
      adminPrincipals = rawAdminPrincipals as string[];
    } else if (typeof rawAdminPrincipals === 'string' && rawAdminPrincipals.trim() !== '') {
      adminPrincipals = JSON.parse(rawAdminPrincipals) as string[];
    }
    adminPrincipals.forEach((principalArn, idx) => {
      new eks.AccessEntry(this, `AdminAccessEntry${idx}`, {
        cluster,
        principal: principalArn,
        accessPolicies: [
          eks.AccessPolicy.fromAccessPolicyName('AmazonEKSClusterAdminPolicy', {
            accessScopeType: eks.AccessScopeType.CLUSTER,
          }),
        ],
      });
    });

    // ============================================================
    // 2. EKS Managed Nodegroup — system nodes
    //    t3.medium × 2, CriticalAddonsOnly taint.
    //    Business workloads must NOT schedule here.
    // ============================================================
    const nodegroupName = `${this.region}-${props.projectName}-nodes`;
    const mng = cluster.addNodegroupCapacity('SystemNodegroup', {
      nodegroupName: nodegroupName,
      amiType: eks.NodegroupAmiType.AL2023_X86_64_STANDARD,
      instanceTypes: [ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM)],
      minSize: 2,
      maxSize: 2,
      desiredSize: 2,
      diskSize: 20,
      capacityType: eks.CapacityType.ON_DEMAND,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      taints: [
        {
          key: 'CriticalAddonsOnly',
          value: 'true',
          effect: eks.TaintEffect.NO_SCHEDULE,
        },
      ],
      tags: {
        'auto-delete': 'no',
        Project: props.projectName,
        Name: `${props.projectName}-nodes`,
      },
    });

    // ============================================================
    // 3. AwsCustomResource: propagate auto-delete=no to MNG ASG.
    //    EKS does NOT push nodegroup tags down to the ASG, so SpringClean
    //    (or any tag-driven cleanup) won't see the protection unless we
    //    set it directly on the ASG with PropagateAtLaunch=true.
    //    See incident 2026-05-14: ASG tag missing -> nodes stopped.
    // ============================================================
    const tagAsg = new AwsCustomResource(this, 'TagSystemAsg', {
      onCreate: {
        service: 'EKS',
        action: 'describeNodegroup',
        parameters: {
          clusterName: props.clusterName,
          nodegroupName: nodegroupName,
        },
        physicalResourceId: PhysicalResourceId.of(`tag-${nodegroupName}-asg`),
      },
      onUpdate: {
        service: 'EKS',
        action: 'describeNodegroup',
        parameters: {
          clusterName: props.clusterName,
          nodegroupName: nodegroupName,
        },
        physicalResourceId: PhysicalResourceId.of(`tag-${nodegroupName}-asg`),
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['eks:DescribeNodegroup', 'autoscaling:CreateOrUpdateTags'],
          resources: ['*'],
        }),
      ]),
      installLatestAwsSdk: false,
    });
    tagAsg.node.addDependency(mng);

    // The describe returns ASG name; chain a second AwsCustomResource that
    // takes that ARN and writes the propagated tag. We can't fully chain
    // outputs here without a Lambda, so use the response token approach:
    // describeNodegroup result has resources.autoScalingGroups[0].name.
    const asgName = tagAsg.getResponseField('nodegroup.resources.autoScalingGroups.0.name');

    const writeAsgTag = new AwsCustomResource(this, 'WriteAsgPropagatedTag', {
      onCreate: {
        service: 'AutoScaling',
        action: 'createOrUpdateTags',
        parameters: {
          Tags: [
            {
              Key: 'auto-delete',
              Value: 'no',
              PropagateAtLaunch: true,
              ResourceId: asgName,
              ResourceType: 'auto-scaling-group',
            },
          ],
        },
        physicalResourceId: PhysicalResourceId.of(`asg-tag-${nodegroupName}`),
      },
      onUpdate: {
        service: 'AutoScaling',
        action: 'createOrUpdateTags',
        parameters: {
          Tags: [
            {
              Key: 'auto-delete',
              Value: 'no',
              PropagateAtLaunch: true,
              ResourceId: asgName,
              ResourceType: 'auto-scaling-group',
            },
          ],
        },
        physicalResourceId: PhysicalResourceId.of(`asg-tag-${nodegroupName}`),
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['autoscaling:CreateOrUpdateTags'],
          resources: ['*'],
        }),
      ]),
      installLatestAwsSdk: false,
    });
    writeAsgTag.node.addDependency(tagAsg);

    // ============================================================
    // 3.5. metrics-server EKS Addon
    //      Required for HPA (metrics.k8s.io API) and `kubectl top`.
    //      EKS does NOT preinstall this. HPA targets memory/cpu
    //      utilization will show <unknown> without it.
    //      v0.8.1-eksbuild.6 is in the compatibility list for K8s 1.35
    //      (the current default for 1.35 is v0.8.1-eksbuild.10; pinning an
    //      older build is fine — bump if you want the latest).
    // ============================================================
    const metricsServerAddon = new eks.Addon(this, 'MetricsServerAddon', {
      cluster,
      addonName: 'metrics-server',
      addonVersion: 'v0.8.1-eksbuild.6',
    });
    metricsServerAddon.node.addDependency(mng);

    // ============================================================
    // ============================================================
    // 4. Tag cluster SG with karpenter.sh/discovery so EC2NodeClass
    //    securityGroupSelectorTerms can find it. The cluster SG is
    //    created by EKS, not CDK, so we use a custom resource to tag.
    // ============================================================
    const tagClusterSg = new AwsCustomResource(this, 'TagClusterSgForKarpenter', {
      onCreate: {
        service: 'EC2',
        action: 'createTags',
        parameters: {
          Resources: [cluster.clusterSecurityGroupId],
          Tags: [
            { Key: 'karpenter.sh/discovery', Value: props.clusterName },
          ],
        },
        physicalResourceId: PhysicalResourceId.of(`tag-cluster-sg-${cluster.clusterName}`),
      },
      onUpdate: {
        service: 'EC2',
        action: 'createTags',
        parameters: {
          Resources: [cluster.clusterSecurityGroupId],
          Tags: [
            { Key: 'karpenter.sh/discovery', Value: props.clusterName },
          ],
        },
        physicalResourceId: PhysicalResourceId.of(`tag-cluster-sg-${cluster.clusterName}`),
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['ec2:CreateTags'],
          resources: ['*'],
        }),
      ]),
      installLatestAwsSdk: false,
    });

    // ============================================================
    // 5. IAM roles
    // ============================================================

    // 5a. Karpenter node role (attached to EC2 instances Karpenter creates)
    const karpenterNodeRole = new iam.Role(this, 'KarpenterNodeRole', {
      roleName: `${this.region}-${props.projectName}-karpenter-node`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    new iam.CfnInstanceProfile(this, 'KarpenterNodeInstanceProfile', {
      instanceProfileName: `${this.region}-${props.projectName}-karpenter-node`,
      roles: [karpenterNodeRole.roleName],
    });

    // EKS access entry so Karpenter-launched nodes can register
    new eks.AccessEntry(this, 'KarpenterNodeAccessEntry', {
      cluster,
      principal: karpenterNodeRole.roleArn,
      accessEntryType: eks.AccessEntryType.EC2_LINUX,
      accessPolicies: [],
    });

    // 5b. Karpenter controller IRSA
    const karpenterPolicyTemplate = fs.readFileSync(
      path.join(__dirname, 'policies', 'karpenter-controller-policy.json'),
      'utf8',
    );
    const karpenterPolicyJson = karpenterPolicyTemplate
      .replace(/\$\{REGION\}/g, this.region)
      .replace(/\$\{CLUSTER_NAME\}/g, props.clusterName)
      .replace(/\$\{NODE_ROLE_ARN\}/g, karpenterNodeRole.roleArn)
      .replace(
        /\$\{CLUSTER_ARN\}/g,
        `arn:aws:eks:${this.region}:${this.account}:cluster/${props.clusterName}`,
      );
    const karpenterPolicyDoc = iam.PolicyDocument.fromJson(JSON.parse(karpenterPolicyJson));

    // Pre-create namespaces for SAs (helm chart createNamespace would happen
     // too late — IRSA SA creation runs before helm install in CDK).
    const karpenterNs = cluster.addManifest('KarpenterNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'karpenter' },
    });
    const esoNs = cluster.addManifest('ExternalSecretsNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'external-secrets' },
    });

    const karpenterControllerSa = cluster.addServiceAccount('KarpenterControllerSa', {
      name: 'karpenter',
      namespace: 'karpenter',
    });
    karpenterControllerSa.node.addDependency(karpenterNs);
    new iam.Policy(this, 'KarpenterControllerPolicy', {
      policyName: `${this.region}-${props.projectName}-karpenter-controller`,
      document: karpenterPolicyDoc,
      roles: [karpenterControllerSa.role],
    });

    // 5c. AWS Load Balancer Controller IRSA
    const albPolicyJson = fs.readFileSync(
      path.join(__dirname, 'policies', 'alb-controller-policy.json'),
      'utf8',
    );
    const albPolicyDoc = iam.PolicyDocument.fromJson(JSON.parse(albPolicyJson));

    const albControllerSa = cluster.addServiceAccount('AlbControllerSa', {
      name: 'aws-load-balancer-controller',
      namespace: 'kube-system',
    });
    new iam.Policy(this, 'AlbControllerPolicy', {
      policyName: `${this.region}-${props.projectName}-lb-controller`,
      document: albPolicyDoc,
      roles: [albControllerSa.role],
    });

    // 5d. External Secrets IRSA
    const esoSa = cluster.addServiceAccount('ExternalSecretsSa', {
      name: 'external-secrets',
      namespace: 'external-secrets',
    });
    esoSa.node.addDependency(esoNs);
    props.litellmSecret.grantRead(esoSa);
    props.rdsSecret.grantRead(esoSa);
    props.redisAuthSecret.grantRead(esoSa);
    props.saltSecret.grantRead(esoSa);

    // 5e. LiteLLM pod IRSA — the litellm Deployment runs as SA `litellm-sa`
    //     and assumes this role to call Bedrock (Claude/Nova, no AKSK) and to
    //     write request/response logs to the S3 logs bucket (s3_v2 callback).
    //     Mirrors prod's litellm-sa -> litellm-irsa-role binding.
    //     The litellm namespace is created here (instead of inside the
    //     manifest helper) so the SA has a namespace to land in.
    const litellmNamespace = cluster.addManifest('LitellmNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: 'litellm' },
    });
    const litellmSa = cluster.addServiceAccount('LitellmSa', {
      name: 'litellm-sa',
      namespace: 'litellm',
    });
    litellmSa.node.addDependency(litellmNamespace);
    // Bedrock invoke (Claude/Nova via IRSA). Scoped to InvokeModel*/Converse* on
    // foundation models + inference profiles (us./global./apac. cross-region
    // profiles route to base models in other regions, so foundation-model is
    // matched across all regions, not just the deploy region).
    litellmSa.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:Converse',
          'bedrock:ConverseStream',
        ],
        resources: [
          `arn:aws:bedrock:*::foundation-model/*`,
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
        ],
      }),
    );
    // AgentCore Web Search gateway invoke (only when that backend is selected).
    // The agentcore_websearch.py callback SigV4-signs requests to the
    // bedrock-agentcore gateway endpoint using these IRSA creds.
    if (props.websearchBackend === 'agentcore') {
      litellmSa.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'InvokeAgentCoreWebSearchGateway',
          actions: ['bedrock-agentcore:InvokeGateway'],
          // AgentCore Web Search gateway (us-east-1 only).
          resources: [
            `arn:aws:bedrock-agentcore:us-east-1:${this.account}:gateway/<AGENTCORE_GATEWAY_ID>`,
          ],
        }),
      );
    }
    // S3 request-log bucket write (s3_v2 callback).
    props.logsBucket.grantWrite(litellmSa);

    // Per-team Bedrock cost attribution (only when enabled). A dedicated exec
    // role carries the same Bedrock invoke permissions; litellm-sa assumes it
    // per request with an STS session tag team=<alias>, so AWS records the
    // assumed-role principal + iamPrincipal/team in CUR 2.0. Bedrock spend is
    // then splittable by team in Cost Explorer.
    if (props.enableBedrockCostAttribution) {
      const bedrockExecRole = new iam.Role(this, 'BedrockExecRole', {
        roleName: `${props.projectName}-bedrock-exec`,
        // Trust: only litellm-sa's IRSA role may assume, and may TagSession.
        assumedBy: new iam.ArnPrincipal(litellmSa.role.roleArn),
        description:
          'Per-team Bedrock exec role assumed by litellm-sa with team session tag (cost attribution)',
      });
      // The trust relationship must allow sts:TagSession (AssumeRole is implied
      // by ArnPrincipal). Add TagSession explicitly to the assume-role policy.
      (bedrockExecRole.assumeRolePolicy as iam.PolicyDocument).addStatements(
        new iam.PolicyStatement({
          actions: ['sts:TagSession'],
          principals: [new iam.ArnPrincipal(litellmSa.role.roleArn)],
        }),
      );
      bedrockExecRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            'bedrock:InvokeModel',
            'bedrock:InvokeModelWithResponseStream',
            'bedrock:Converse',
            'bedrock:ConverseStream',
          ],
          resources: [
            `arn:aws:bedrock:*::foundation-model/*`,
            `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
          ],
        }),
      );
      // litellm-sa may assume + tag the exec role.
      litellmSa.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'AssumeBedrockExecForCostAttribution',
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          resources: [bedrockExecRole.roleArn],
        }),
      );
      this.bedrockExecRoleArn = bedrockExecRole.roleArn;
      new cdk.CfnOutput(this, 'BedrockExecRoleArn', {
        value: bedrockExecRole.roleArn,
      });
    }

    // ============================================================
    // 6. Helm charts
    //    Order: external-secrets first (other manifests depend on it),
    //    then aws-lbc (ingress depends on it),
    //    then karpenter (nodepool/nodeclass depend on it).
    // ============================================================
    const externalSecretsChart = cluster.addHelmChart('ExternalSecrets', {
      chart: 'external-secrets',
      repository: 'https://charts.external-secrets.io',
      release: 'external-secrets',
      version: '0.10.7', // helm chart version (app version is v0.10.x)
      namespace: 'external-secrets',
      createNamespace: false,
      wait: true,
      timeout: cdk.Duration.minutes(15),
      values: {
        installCRDs: true,
        replicaCount: 1,
        serviceAccount: {
          create: false,
          name: 'external-secrets',
        },
        // Tolerate CriticalAddonsOnly taint so pods can schedule on system MNG.
        tolerations: [
          {
            key: 'CriticalAddonsOnly',
            operator: 'Exists',
          },
        ],
        webhook: {
          replicaCount: 1,
          tolerations: [
            {
              key: 'CriticalAddonsOnly',
              operator: 'Exists',
            },
          ],
        },
        certController: {
          replicaCount: 1,
          tolerations: [
            {
              key: 'CriticalAddonsOnly',
              operator: 'Exists',
            },
          ],
        },
      },
    });
    // Helm install must wait until SA exists, otherwise it would create one.
    externalSecretsChart.node.addDependency(esoSa);

    const albControllerChart = cluster.addHelmChart('AwsLoadBalancerController', {
      chart: 'aws-load-balancer-controller',
      repository: 'https://aws.github.io/eks-charts',
      release: 'aws-load-balancer-controller',
      version: '1.13.0', // matches app v3.3.0 controller image
      namespace: 'kube-system',
      wait: true,
      timeout: cdk.Duration.minutes(15),
      values: {
        clusterName: props.clusterName,
        // AL2023 lowers the IMDS hop limit to 1 by default which blocks ALB
        // controller's IMDS-based VPC discovery. Pass vpcId + region explicitly
        // so the controller never falls back to IMDS.
        vpcId: props.vpc.vpcId,
        region: cdk.Stack.of(this).region,
        serviceAccount: {
          create: false,
          name: 'aws-load-balancer-controller',
        },
        // Avoid noisy default webhook on managed nodes during early cluster init.
        enableServiceMutatorWebhook: false,
        // Single replica reduces resource pressure on the 2x t3.medium system MNG.
        replicaCount: 1,
        // System nodes are tainted CriticalAddonsOnly; ALB controller must tolerate
        // it to schedule, otherwise webhook has no endpoints and ingress creation
        // fails before karpenter has a chance to provision worker nodes.
        tolerations: [
          {
            key: 'CriticalAddonsOnly',
            operator: 'Exists',
          },
        ],
      },
    });
    albControllerChart.node.addDependency(albControllerSa);
    albControllerChart.node.addDependency(mng);

    const karpenterChart = cluster.addHelmChart('Karpenter', {
      chart: 'karpenter',
      // OCI registry: repository must include the namespace; full ref becomes
      // public.ecr.aws/karpenter/karpenter:1.5.0
      repository: 'oci://public.ecr.aws/karpenter/karpenter',
      release: 'karpenter',
      version: '1.5.0',
      namespace: 'karpenter',
      createNamespace: false,
      values: {
        settings: {
          clusterName: props.clusterName,
          clusterEndpoint: cluster.clusterEndpoint,
          // No SQS interruption queue — matches source environment.
          interruptionQueue: '',
        },
        serviceAccount: {
          create: false,
          name: 'karpenter',
        },
        controller: {
          resources: {
            requests: { cpu: '200m', memory: '512Mi' },
            limits: { cpu: '1', memory: '1Gi' },
          },
        },
        // Karpenter pods must not run on Karpenter-provisioned nodes
        // (anti-self-eviction); managed nodegroup taint must be tolerated.
        tolerations: [
          {
            key: 'CriticalAddonsOnly',
            operator: 'Exists',
          },
        ],
      },
    });
    karpenterChart.node.addDependency(karpenterControllerSa);
    karpenterChart.node.addDependency(mng);
    karpenterChart.node.addDependency(tagClusterSg);

    // ============================================================
    // 6b. Edge / SSO resources for the litellm UI ingress:
    //     Cognito UserPool (SSO), ACM wildcard cert, WAFv2 WebACL.
    //     The ALB itself is created in-cluster by the ALB controller at
    //     deploy time; these provide the cert/WAF the ingress annotations
    //     reference, plus the Cognito OIDC endpoints litellm uses for SSO.
    // ============================================================
    // Ingress host = <hostPrefix>.<domain>. Default `litellm`; override with
    // `-c hostPrefix=litellm-sg` so a second deployment in another region does
    // NOT collide with the prod `litellm.<domain>` DNS record / cert.
    const hostPrefix =
      (this.node.tryGetContext('hostPrefix') as string) ?? 'litellm';
    const uiHost = `${hostPrefix}.${props.domain}`;

    // --- Cognito UserPool + hosted domain + UI client (OIDC) ---
    const userPool = new cognito.UserPool(this, 'LitellmUserPool', {
      userPoolName: 'litellm',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Hosted UI domain prefix `litellm-<ACCOUNT_ID>` -> produces
    // https://litellm-<ACCOUNT_ID>.auth.<region>.amazoncognito.com
    const userPoolDomain = userPool.addDomain('LitellmUserPoolDomain', {
      cognitoDomain: { domainPrefix: `litellm-${this.account}` },
    });

    const userPoolClient = userPool.addClient('LitellmUiClient', {
      userPoolClientName: 'litellm-ui',
      generateSecret: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: [`https://${uiHost}/sso/callback`],
        logoutUrls: [`https://${uiHost}`],
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    });

    // The Cognito hosted-UI base URL. Endpoints below are derived from the
    // live UserPoolDomain so they stay consistent with what Cognito serves.
    const cognitoBaseUrl = userPoolDomain.baseUrl();

    // --- ACM wildcard cert *.<domain> validated via Route53 ---
    // Use fromHostedZoneAttributes (no live lookup) so synth needs no creds.
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: props.hostedZoneId,
      zoneName: props.domain,
    });
    const certificate = new acm.Certificate(this, 'LitellmCert', {
      domainName: `*.${props.domain}`,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // --- WAFv2 WebACL (REGIONAL, for ALB) — reproduces litellm-waf ---
    // DefaultAction Allow. Rules below mirror the live WAF. Priorities 0-2
    // are observation-only (Count/overrideAction Count) — they do NOT block;
    // only the per-IP rate limit (priority 3) blocks.
    const webAcl = new wafv2.CfnWebACL(this, 'LitellmWaf', {
      name: 'litellm-waf',
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'litellm-waf',
      },
      rules: [
        // priority 0 — RequireAuthHeader: COUNT-only (observation, not block).
        // Fires on requests that are NOT to a public path AND have no
        // Authorization header. The exact public-path list came from the
        // live WAF. The "no auth header" clause is approximated as
        // NOT(authorization header contains a space) — present bearer tokens
        // contain a space ("Bearer x"), so this counts unauthenticated reqs.
        {
          name: 'RequireAuthHeader',
          priority: 0,
          action: { count: {} },
          statement: {
            andStatement: {
              statements: [
                {
                  notStatement: {
                    statement: {
                      orStatement: {
                        statements: [
                          '/ui',
                          '/sso',
                          '/health',
                          '/.well-known',
                          '/get_image',
                          '/public',
                          '/favicon',
                        ].map((p) => ({
                          byteMatchStatement: {
                            fieldToMatch: { uriPath: {} },
                            positionalConstraint: 'STARTS_WITH',
                            searchString: p,
                            textTransformations: [
                              { priority: 0, type: 'NONE' },
                            ],
                          },
                        })),
                      },
                    },
                  },
                },
                {
                  notStatement: {
                    statement: {
                      byteMatchStatement: {
                        fieldToMatch: { singleHeader: { Name: 'authorization' } },
                        positionalConstraint: 'CONTAINS',
                        searchString: ' ',
                        textTransformations: [{ priority: 0, type: 'NONE' }],
                      },
                    },
                  },
                },
              ],
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'RequireAuthHeader',
          },
        },
        // priority 1 — AWS Common Rule Set (override to Count, observation).
        {
          name: 'AWS-AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { count: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'AWS-AWSManagedRulesCommonRuleSet',
          },
        },
        // priority 2 — AWS Known Bad Inputs (override to Count, observation).
        {
          name: 'AWS-AWSManagedRulesKnownBadInputsRuleSet',
          priority: 2,
          overrideAction: { count: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'AWS-AWSManagedRulesKnownBadInputsRuleSet',
          },
        },
        // priority 3 — per-IP rate limit, 1000/5min: the ONLY blocking rule.
        {
          name: 'RateLimit-1000-per-IP',
          priority: 3,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 1000,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimit-1000-per-IP',
          },
        },
      ],
    });

    // ============================================================
    // 7. k8s manifests (namespace, ESO, configmap, app, ingress,
    //    hpa, pdb, Karpenter EC2NodeClass + NodePool).
    // ============================================================
    addLitellmManifests(this, cluster, {
      ...props,
      externalSecretsChart,
      albControllerChart,
      karpenterChart,
      karpenterNodeRoleName: karpenterNodeRole.roleName,
      esoServiceAccountName: 'external-secrets',
      litellmNamespace,
      litellmServiceAccountName: 'litellm-sa',
      uiHost,
      cognitoBaseUrl,
      certificateArn: certificate.certificateArn,
      wafAclArn: webAcl.attrArn,
      bedrockExecRoleArn: this.bedrockExecRoleArn,
    });

    // ---- Cognito / DNS outputs + post-deploy reminders for the human ----
    new cdk.CfnOutput(this, 'UiHost', { value: uiHost });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
    });
    new cdk.CfnOutput(this, 'CognitoHostedUiBaseUrl', { value: cognitoBaseUrl });
    new cdk.CfnOutput(this, 'WafWebAclArn', { value: webAcl.attrArn });
    new cdk.CfnOutput(this, 'CertificateArn', { value: certificate.certificateArn });
    // TODO(deployer): after deploy, push the Cognito UI client id/secret into
    // the litellm config secret so the ExternalSecret picks them up:
    //   aws secretsmanager update-secret --secret-id <region>-litellm/config \
    //     --secret-string '{"...","GENERIC_CLIENT_ID":"<clientId>",
    //       "GENERIC_CLIENT_SECRET":"<clientSecret>", ...}'
    new cdk.CfnOutput(this, 'PostDeploySecretReminder', {
      value:
        'Run update-secret to set GENERIC_CLIENT_ID/GENERIC_CLIENT_SECRET ' +
        '(from UserPoolClientId + its secret) plus the other CHANGE_ME keys.',
    });
    // TODO(deployer): the ALB DNS name is only known after the ALB controller
    // provisions the LB at deploy time, so the Route53 A-alias cannot be made
    // in CDK. After deploy, create it manually or via external-dns:
    //   litellm.<domain>  ALIAS-> <alb-dns-name>
    new cdk.CfnOutput(this, 'Route53AliasReminder', {
      value: `Create Route53 A-alias ${uiHost} -> <ALB DNS> after deploy (manual or external-dns).`,
    });

    new cdk.CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'ClusterEndpoint', { value: cluster.clusterEndpoint });
    new cdk.CfnOutput(this, 'UpdateKubeconfigCommand', {
      value: `aws eks update-kubeconfig --name ${cluster.clusterName} --region ${this.region}`,
    });
  }
}

// ============================================================
// Manifest helper — separated for readability
// ============================================================
interface ManifestProps extends ClusterStackProps {
  externalSecretsChart: eks.HelmChart;
  albControllerChart: eks.HelmChart;
  karpenterChart: eks.HelmChart;
  karpenterNodeRoleName: string;
  esoServiceAccountName: string;
  /** litellm namespace manifest (created in ClusterStack body). */
  litellmNamespace: eks.KubernetesManifest;
  /** litellm pod IRSA service account name. */
  litellmServiceAccountName: string;
  /** litellm.<domain> — ingress host + PROXY_BASE_URL. */
  uiHost: string;
  /** Cognito hosted-UI base URL (https://litellm-<acct>.auth.<region>.amazoncognito.com). */
  cognitoBaseUrl: string;
  certificateArn: string;
  wafAclArn: string;
  /** Bedrock exec role ARN (present only when enableBedrockCostAttribution). */
  bedrockExecRoleArn?: string;
}

function addLitellmManifests(scope: Construct, cluster: eks.Cluster, props: ManifestProps) {
  const ns = 'litellm';

  // Karpenter NodePool zone constraint. init-env writes nodepoolZones with the
  // actual usable AZs (filtered by instance-type capacity). Fallback (no
  // init-env): derive <region>{a,b,...} for `maxAzs` zones — MUST match the VPC
  // maxAzs (default 2), else Karpenter targets an AZ with no subnet and pods
  // stay Pending (see #6 in docs/deploy-to-new-region.md). Override with
  // `-c nodepoolZones='["ap-southeast-1a","ap-southeast-1b"]'`.
  const region = cdk.Stack.of(scope).region;
  const maxAzs = Number(scope.node.tryGetContext('maxAzs') ?? 2);
  const zoneCtx = scope.node.tryGetContext('nodepoolZones');
  const nodepoolZones: string[] = Array.isArray(zoneCtx)
    ? (zoneCtx as string[])
    : typeof zoneCtx === 'string' && zoneCtx.trim() !== ''
      ? (JSON.parse(zoneCtx) as string[])
      : Array.from({ length: maxAzs }, (_, i) => `${region}${String.fromCharCode(97 + i)}`);

  // 1. namespace — created in ClusterStack body (so the litellm IRSA SA has a
  //    namespace to land in); reuse it here for manifest dependencies.
  const namespace = props.litellmNamespace;

  // 2. ClusterSecretStore (uses ESO IRSA SA via JWT auth)
  const clusterSecretStore = cluster.addManifest('AwsSecretsManagerStore', {
    apiVersion: 'external-secrets.io/v1beta1',
    kind: 'ClusterSecretStore',
    metadata: { name: 'aws-secrets-manager' },
    spec: {
      provider: {
        aws: {
          service: 'SecretsManager',
          region: cdk.Stack.of(scope).region,
          auth: {
            jwt: {
              serviceAccountRef: {
                name: props.esoServiceAccountName,
                namespace: 'external-secrets',
              },
            },
          },
        },
      },
    },
  });
  clusterSecretStore.node.addDependency(props.externalSecretsChart);

  // 3. ExternalSecret — pulls litellm/config + rds-master secrets and
  //    builds DATABASE_URL via templating.
  const externalSecret = cluster.addManifest('LitellmExternalSecret', {
    apiVersion: 'external-secrets.io/v1beta1',
    kind: 'ExternalSecret',
    metadata: { name: 'litellm-secrets', namespace: ns },
    spec: {
      refreshInterval: '1h',
      secretStoreRef: { name: 'aws-secrets-manager', kind: 'ClusterSecretStore' },
      target: {
        name: 'litellm-secrets',
        creationPolicy: 'Owner',
        template: {
          engineVersion: 'v2',
          // ESO `dataFrom.rewrite` with target `config.$1` / `rds.$1`
          // produces flat keys (e.g. `config.LITELLM_MASTER_KEY`) on the
          // template root context, not a nested `.config` object. Go
          // templates can't traverse a dotted key as a path, so we must
          // use `index . "config.X"` to access them.
          // 10 keys mirroring the litellm/config secret (DATABASE_URL is the
          // 10th, built here from the RDS-managed secret).
          data: {
            LITELLM_MASTER_KEY: '{{ index . "config.LITELLM_MASTER_KEY" }}',
            // From the dedicated salt secret (4th dataFrom), NOT the config
            // secret, so it is auto-generated once and stays stable.
            LITELLM_SALT_KEY: '{{ index . "salt.LITELLM_SALT_KEY" }}',
            // Injected directly from props.redisHost (NOT config.REDIS_HOST):
            // keeps the LitellmConfig secret template free of deploy-computed
            // values, so CFN can't regenerate it and wipe hand-filled creds.
            REDIS_HOST: props.redisHost,
            REDIS_PORT: '6379',
            // From the redis-auth secret (3rd dataFrom), NOT the config secret,
            // so AUTH-token rotation propagates to litellm without drift.
            REDIS_PASSWORD: '{{ index . "redis.password" }}',
            GENERIC_CLIENT_ID: '{{ index . "config.GENERIC_CLIENT_ID" }}',
            GENERIC_CLIENT_SECRET: '{{ index . "config.GENERIC_CLIENT_SECRET" }}',
            BEDROCK_MANTLE_API_KEY: '{{ index . "config.BEDROCK_MANTLE_API_KEY" }}',
            GEMINI_API_KEY: '{{ index . "config.GEMINI_API_KEY" }}',
            UI_PASSWORD: '{{ index . "config.UI_PASSWORD" }}',
            // Built from RDS-managed secret. host/port/username/password
            // are RDS managed; database name is templated in.
            DATABASE_URL: `postgresql://{{ index . "rds.username" }}:{{ index . "rds.password" }}@{{ index . "rds.host" }}:{{ index . "rds.port" }}/${props.databaseName}`,
          },
        },
      },
      dataFrom: [
        {
          extract: {
            key: props.litellmSecret.secretName,
          },
          rewrite: [{ regexp: { source: '(.*)', target: 'config.$1' } }],
        },
        {
          extract: {
            key: props.rdsSecret.secretName,
          },
          rewrite: [{ regexp: { source: '(.*)', target: 'rds.$1' } }],
        },
        {
          // ElastiCache AUTH token (JSON secret, key `password`). Synced here
          // so rotation reaches litellm without drift; -> redis.password.
          extract: {
            key: props.redisAuthSecret.secretName,
          },
          rewrite: [{ regexp: { source: '(.*)', target: 'redis.$1' } }],
        },
        {
          // Dedicated SALT secret (JSON, key LITELLM_SALT_KEY). Created
          // out-of-band and only REFERENCED by DataStack (never created/
          // regenerated by CDK), so it's stable across deploys;
          // -> salt.LITELLM_SALT_KEY.
          extract: {
            key: props.saltSecret.secretName,
          },
          rewrite: [{ regexp: { source: '(.*)', target: 'salt.$1' } }],
        },
      ],
    },
  });
  externalSecret.node.addDependency(clusterSecretStore);
  externalSecret.node.addDependency(namespace);

  // 4. ConfigMap (litellm config.yaml) — generated dynamically from Bedrock
  // profile discovery. Profiles are passed via CDK context (_bedrockProfiles)
  // which is populated by `scripts/init-env.ts`. If empty, falls back to
  // global. prefix for all models (works in most regions).
  const bedrockRegion =
    (scope.node.tryGetContext('bedrockRegion') as string) ?? cdk.Stack.of(scope).region;
  const bedrockProfiles: string[] =
    (scope.node.tryGetContext('_bedrockProfiles') as string[]) ?? [];
  const websearchBackend = props.websearchBackend ?? 'searxng';
  const litellmConfigYaml = buildLitellmConfig({
    bedrockRegion,
    s3BucketName: props.logsBucket.bucketName,
    availableProfiles: bedrockProfiles,
    websearchBackend,
    enableBedrockCostAttribution: props.enableBedrockCostAttribution,
  });
  // When the AgentCore backend is selected, ship the custom callback module
  // INSIDE the litellm-config ConfigMap. LiteLLM's get_instance_fn resolves a
  // callback module relative to the config-file dir (/app/config), ignoring
  // PYTHONPATH — so the .py MUST live next to config.yaml in the same mount.
  const configData: Record<string, string> = { 'config.yaml': litellmConfigYaml };
  if (websearchBackend === 'agentcore') {
    configData['agentcore_websearch.py'] = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        '..',
        'agentcore-websearch-litellm',
        'src',
        'agentcore_websearch.py',
      ),
      'utf8',
    );
  }
  // Ship the per-team cost-attribution hook into /app/config when enabled. The
  // callback is NOT auto-added to config.yaml here — activate it deliberately
  // (add 'bedrock_team_tag_hook.bedrock_team_tag_hook_instance' to callbacks)
  // once the IAM chain is verified, so building the resources never changes the
  // live Bedrock call path on its own.
  if (props.enableBedrockCostAttribution) {
    configData['bedrock_team_tag_hook.py'] = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        '..',
        'bedrock-cost-attribution',
        'src',
        'bedrock_team_tag_hook.py',
      ),
      'utf8',
    );
  }
  const configMap = cluster.addManifest('LitellmConfigMap', {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'litellm-config', namespace: ns },
    data: configData,
  });
  configMap.node.addDependency(namespace);

  // 4b. searxng — backing search engine for litellm web-search (SEARXNG_API_BASE).
  //     ConfigMap ships a complete, valid settings.yml so searxng starts
  //     cleanly on first deploy — no manual inject step required.
  //
  //     server.secret_key only signs the web-UI session cookie. Our SearXNG is
  //     ClusterIP-internal and only called by litellm via stateless JSON API
  //     (/search?format=json), so the value is functionally inert here. A
  //     fixed string is fine and keeps `cdk diff` clean across redeploys.
  const searxngSettingsYaml = `use_default_settings: true

general:
  instance_name: "SearXNG-LiteLLM"

search:
  safe_search: 1
  default_lang: "all"
  formats:
    - html
    - json

server:
  secret_key: "litellm-searxng-not-secret"
  limiter: false
  image_proxy: false

# Engine selection for high-frequency AI calls
engines:
  - name: google
    disabled: false         # Enabled - broad coverage
  - name: bing
    disabled: false         # Enabled - broad coverage
  - name: baidu
    disabled: false         # Enabled - China / Chinese-language coverage
  - name: startpage
    disabled: true          # Rate-limited
  - name: duckduckgo
    disabled: false         # Primary engine - stable
  - name: wikipedia
    disabled: false         # Good for knowledge queries
  - name: brave
    disabled: false         # Friendly to automation
  - name: qwant
    disabled: false         # EU search engine, stable
`;
  const searxngConfigMap = cluster.addManifest('SearxngConfigMap', {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'searxng-config', namespace: ns },
    data: { 'settings.yml': searxngSettingsYaml },
  });
  searxngConfigMap.node.addDependency(namespace);

  const searxngDeployment = cluster.addManifest('SearxngDeployment', {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'searxng', namespace: ns },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'searxng' } },
      template: {
        metadata: { labels: { app: 'searxng' } },
        spec: {
          containers: [
            {
              name: 'searxng',
              // Pinned for reproducibility (was :latest). Bump deliberately.
              image: 'searxng/searxng:2026.6.18-b5ef7ec8f',
              ports: [{ name: 'http', containerPort: 8080 }],
              env: [{ name: 'SEARXNG_PORT', value: '8080' }],
              resources: {
                requests: { cpu: '100m', memory: '128Mi' },
                limits: { cpu: '500m', memory: '256Mi' },
              },
              volumeMounts: [
                { name: 'config', mountPath: '/etc/searxng', readOnly: true },
              ],
            },
          ],
          volumes: [{ name: 'config', configMap: { name: 'searxng-config' } }],
        },
      },
    },
  });
  searxngDeployment.node.addDependency(searxngConfigMap);

  const searxngService = cluster.addManifest('SearxngService', {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'searxng', namespace: ns },
    spec: {
      type: 'ClusterIP',
      selector: { app: 'searxng' },
      ports: [{ name: 'http', port: 8080, targetPort: 8080, protocol: 'TCP' }],
    },
  });
  searxngService.node.addDependency(namespace);

  // 5. Service
  const service = cluster.addManifest('LitellmService', {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'litellm', namespace: ns },
    spec: {
      type: 'ClusterIP',
      selector: { app: 'litellm' },
      ports: [{ name: 'http', port: 4000, targetPort: 4000, protocol: 'TCP' }],
    },
  });
  service.node.addDependency(namespace);

  // 6. Deployment — matches real prod.
  //    NOTE (nodeSelector): real prod runs an EMPTY nodeSelector. litellm
  //    pods land on Karpenter (litellm-nodepool) nodes because the system
  //    MNG is tainted CriticalAddonsOnly and litellm has no matching
  //    toleration, so the scheduler can only place them on the untainted
  //    Karpenter nodes. Do NOT add `provisioned-by: karpenter` here.
  const deployment = cluster.addManifest('LitellmDeployment', {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'litellm', namespace: ns },
    spec: {
      replicas: 3,
      strategy: {
        type: 'RollingUpdate',
        rollingUpdate: { maxSurge: 0, maxUnavailable: 1 },
      },
      selector: { matchLabels: { app: 'litellm' } },
      template: {
        metadata: {
          labels: { app: 'litellm' },
          annotations: {
            'instrumentation.opentelemetry.io/inject-python': 'false',
            'instrumentation.opentelemetry.io/inject-java': 'false',
            'instrumentation.opentelemetry.io/inject-nodejs': 'false',
            'instrumentation.opentelemetry.io/inject-dotnet': 'false',
          },
        },
        spec: {
          // Run as the litellm IRSA SA so Bedrock calls use the pod role
          // (no AKSK) and s3_v2 can write to the logs bucket.
          serviceAccountName: props.litellmServiceAccountName,
          terminationGracePeriodSeconds: 60,
          topologySpreadConstraints: [
            {
              maxSkew: 1,
              topologyKey: 'topology.kubernetes.io/zone',
              whenUnsatisfiable: 'DoNotSchedule',
              labelSelector: { matchLabels: { app: 'litellm' } },
            },
            {
              maxSkew: 1,
              topologyKey: 'kubernetes.io/hostname',
              whenUnsatisfiable: 'DoNotSchedule',
              labelSelector: { matchLabels: { app: 'litellm' } },
            },
          ],
          containers: [
            {
              name: 'litellm',
              image: props.litellmImage,
              imagePullPolicy: 'IfNotPresent',
              // config is mounted as a DIRECTORY at /app/config, so the
              // config file path is /app/config/config.yaml. num_workers=1
              // (official prod recommendation: 1 worker/pod, scale horizontally).
              // --max_requests_before_restart: worker recycling to bound memory
              // growth from large-context non-streaming requests.
              args: [
                '--config',
                '/app/config/config.yaml',
                '--port',
                '4000',
                '--num_workers',
                '1',
                '--max_requests_before_restart',
                '10000',
              ],
              ports: [
                { name: 'http', containerPort: 4000 },
                { name: 'health', containerPort: 8001 },
              ],
              envFrom: [{ secretRef: { name: 'litellm-secrets' } }],
              // Plaintext (non-secret) env — these are literal in real prod.
              // <ACCOUNT_ID> resolves via the Cognito hosted-UI base URL;
              // <DOMAIN> via the litellm.<domain> ingress host.
              env: [
                { name: 'LITELLM_LOG', value: 'INFO' },
                { name: 'SEARXNG_API_BASE', value: 'http://searxng:8080' },
                { name: 'PRISMA_BINARY_CACHE_DIR', value: '/tmp/prisma' },
                { name: 'HOME', value: '/tmp' },
                { name: 'LITELLM_MIGRATION_DIR', value: '/tmp/migrations' },
                {
                  name: 'GENERIC_AUTHORIZATION_ENDPOINT',
                  value: `${props.cognitoBaseUrl}/oauth2/authorize`,
                },
                {
                  name: 'GENERIC_TOKEN_ENDPOINT',
                  value: `${props.cognitoBaseUrl}/oauth2/token`,
                },
                {
                  name: 'GENERIC_USERINFO_ENDPOINT',
                  value: `${props.cognitoBaseUrl}/oauth2/userInfo`,
                },
                { name: 'PROXY_BASE_URL', value: `https://${props.uiHost}` },
                { name: 'GENERIC_CLIENT_STATE', value: 'litellm-sso' },
                { name: 'AUTO_REDIRECT_UI_LOGIN_TO_SSO', value: 'true' },
                {
                  name: 'GENERIC_ROLE_MAPPINGS_GROUP_CLAIM',
                  value: 'cognito:groups',
                },
                {
                  name: 'GENERIC_ROLE_MAPPINGS_ROLES',
                  value:
                    "{'proxy_admin': ['admin'], 'proxy_admin_viewer': ['viewer'], 'internal_user': ['users'], 'internal_user_viewer': ['user_viewer']}",
                },
                { name: 'UI_USERNAME', value: 'admin' },
                // AgentCore Web Search backend config (read by
                // agentcore_websearch.py). Region is pinned to us-east-1 — the
                // only region AgentCore Web Search runs in — regardless of the
                // pod's region. Empty array spread when backend is searxng.
                ...(websearchBackend === 'agentcore'
                  ? [
                      { name: 'AGENTCORE_WS_REGION', value: 'us-east-1' },
                      {
                        name: 'AGENTCORE_WS_MCP_URL',
                        value:
                          'https://<AGENTCORE_GATEWAY_ID>.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp',
                      },
                      {
                        name: 'AGENTCORE_WS_TOOL_NAME',
                        value: 'web-search-tool___WebSearch',
                      },
                    ]
                  : []),
                // Per-team cost attribution: the exec role the hook assumes.
                // Harmless when set but callback inactive (hook only reads it
                // when invoked). Empty spread when attribution is disabled.
                ...(props.enableBedrockCostAttribution && props.bedrockExecRoleArn
                  ? [
                      {
                        name: 'BEDROCK_EXEC_ROLE_ARN',
                        value: props.bedrockExecRoleArn,
                      },
                    ]
                  : []),
              ],
              resources: {
                requests: { cpu: '1', memory: '4Gi' },
                limits: { cpu: '2', memory: '8Gi' },
              },
              livenessProbe: {
                httpGet: { path: '/health/liveliness', port: 4000 },
                initialDelaySeconds: 60,
                periodSeconds: 15,
                timeoutSeconds: 5,
                failureThreshold: 3,
              },
              startupProbe: {
                httpGet: { path: '/health/readiness', port: 4000 },
                periodSeconds: 10,
                timeoutSeconds: 5,
                failureThreshold: 30, // 30 × 10s = 5 min startup window
              },
              readinessProbe: {
                httpGet: { path: '/health/readiness', port: 4000 },
                initialDelaySeconds: 0,
                periodSeconds: 5,
                timeoutSeconds: 5,
                failureThreshold: 3,
              },
              // ConfigMap mounted as a directory (NOT subPath single file).
              volumeMounts: [
                {
                  name: 'config',
                  mountPath: '/app/config',
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            { name: 'config', configMap: { name: 'litellm-config' } },
          ],
        },
      },
    },
  });
  deployment.node.addDependency(configMap);
  deployment.node.addDependency(externalSecret);

  // 7. Ingress — internet-facing ALB + ACM cert + WAF + Route53 host.
  //    The ALB controller associates the WAF WebACL via the wafv2-acl-arn
  //    annotation (no CfnWebACLAssociation needed).
  const ingress = cluster.addManifest('LitellmIngress', {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: {
      name: 'litellm',
      namespace: ns,
      annotations: {
        'kubernetes.io/ingress.class': 'alb',
        'alb.ingress.kubernetes.io/scheme': 'internet-facing',
        'alb.ingress.kubernetes.io/target-type': 'ip',
        'alb.ingress.kubernetes.io/listen-ports': '[{"HTTPS":443},{"HTTP":80}]',
        'alb.ingress.kubernetes.io/ssl-redirect': '443',
        'alb.ingress.kubernetes.io/certificate-arn': props.certificateArn,
        'alb.ingress.kubernetes.io/wafv2-acl-arn': props.wafAclArn,
        'alb.ingress.kubernetes.io/healthcheck-path': '/health/readiness',
        'alb.ingress.kubernetes.io/healthcheck-port': '4000',
        'alb.ingress.kubernetes.io/tags': `auto-delete=no,Project=${props.projectName},ManagedBy=cdk`,
      },
    },
    spec: {
      rules: [
        {
          host: props.uiHost,
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: { service: { name: 'litellm', port: { number: 4000 } } },
              },
            ],
          },
        },
      ],
    },
  });
  ingress.node.addDependency(props.albControllerChart);
  ingress.node.addDependency(service);

  // 8. HPA + PDB
  const hpa = cluster.addManifest('LitellmHpa', {
    apiVersion: 'autoscaling/v2',
    kind: 'HorizontalPodAutoscaler',
    metadata: { name: 'litellm-hpa', namespace: ns },
    spec: {
      scaleTargetRef: { apiVersion: 'apps/v1', kind: 'Deployment', name: 'litellm' },
      minReplicas: 3,
      maxReplicas: 20,
      metrics: [
        // litellm is a streaming LLM proxy: memory grows with active SSE
        // connections (10-100MB/stream) and concurrent request buffers,
        // while CPU stays low during async I/O wait.
        // Keep BOTH signals — HPA scales on whichever fires first (max).
        //
        // Memory request is 4Gi (matches prod). With an 80% memory target
        // and a ~2.5Gi baseline, idle utilization sits at ~62%, so a modest
        // load-driven memory bump trips the HPA. (If you want more headroom
        // before scaling, raise the request rather than the target.)
        //
        // CPU target is 65% (below the 70% default) so HPA reacts before
        // pods are CPU-throttled during the 30-60s pod startup window.
        { type: 'Resource', resource: { name: 'cpu', target: { type: 'Utilization', averageUtilization: 60 } } },
        { type: 'Resource', resource: { name: 'memory', target: { type: 'Utilization', averageUtilization: 80 } } },
      ],
      behavior: {
        scaleUp: {
          stabilizationWindowSeconds: 30,
          policies: [
            { type: 'Percent', value: 100, periodSeconds: 30 },
            { type: 'Pods', value: 4, periodSeconds: 30 },
          ],
          selectPolicy: 'Max',
        },
        scaleDown: {
          stabilizationWindowSeconds: 300,
          policies: [{ type: 'Percent', value: 50, periodSeconds: 60 }],
        },
      },
    },
  });
  hpa.node.addDependency(deployment);

  const pdb = cluster.addManifest('LitellmPdb', {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: { name: 'litellm-pdb', namespace: ns },
    spec: { minAvailable: 2, selector: { matchLabels: { app: 'litellm' } } },
  });
  pdb.node.addDependency(deployment);

  // 9. Karpenter EC2NodeClass + NodePool — must wait until Karpenter
  //    helm install completes (CRDs registered).
  const ec2NodeClass = cluster.addManifest('Ec2NodeClass', {
    apiVersion: 'karpenter.k8s.aws/v1',
    kind: 'EC2NodeClass',
    metadata: { name: 'default' },
    spec: {
      amiFamily: 'AL2023',
      amiSelectorTerms: [{ alias: 'al2023@latest' }],
      role: props.karpenterNodeRoleName,
      subnetSelectorTerms: [{ tags: { 'karpenter.sh/discovery': props.clusterName } }],
      securityGroupSelectorTerms: [{ tags: { 'karpenter.sh/discovery': props.clusterName } }],
      tags: {
        'karpenter.sh/discovery': props.clusterName,
        'auto-delete': 'no',
      },
    },
  });
  ec2NodeClass.node.addDependency(props.karpenterChart);

  const nodePool = cluster.addManifest('NodePool', {
    apiVersion: 'karpenter.sh/v1',
    kind: 'NodePool',
    metadata: { name: 'litellm-nodepool' },
    spec: {
      template: {
        // Label kept for selectability; the litellm deployment does NOT
        // hard-require it (see deployment nodeSelector note).
        metadata: { labels: { 'provisioned-by': 'karpenter' } },
        spec: {
          nodeClassRef: {
            group: 'karpenter.k8s.aws',
            kind: 'EC2NodeClass',
            name: 'default',
          },
          requirements: [
            { key: 'kubernetes.io/arch', operator: 'In', values: ['arm64'] },
            { key: 'kubernetes.io/os', operator: 'In', values: ['linux'] },
            { key: 'karpenter.sh/capacity-type', operator: 'In', values: ['on-demand'] },
            {
              key: 'node.kubernetes.io/instance-type',
              operator: 'In',
              values: ['r6g.large', 'r7g.large'],
            },
            {
              key: 'topology.kubernetes.io/zone',
              operator: 'In',
              // Derive the 3 AZs from the deploy region (a/b/c) so this is not
              // pinned to us-east-1. Override with `-c nodepoolZones='["...a","...b"]'`
              // if the region's usable AZ letters differ.
              values: nodepoolZones,
            },
          ],
          expireAfter: '720h',
        },
      },
      limits: { cpu: 8, memory: '48Gi' },
      disruption: {
        consolidationPolicy: 'WhenEmptyOrUnderutilized',
        consolidateAfter: '30m',
      },
    },
  });
  nodePool.node.addDependency(ec2NodeClass);
}
