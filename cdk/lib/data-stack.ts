import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface DataStackProps extends cdk.StackProps {
  readonly vpc: ec2.IVpc;
  readonly sharedNodeSecurityGroup: ec2.ISecurityGroup;
  readonly projectName: string;
}

/**
 * RDS Postgres + ElastiCache Redis + S3 logs + Secrets Manager.
 *
 * Replicates source terraform/{rds,redis,s3,secrets-manager}.tf.
 *
 * Two Secrets Manager secrets are created:
 *   1. {projectName}/rds-master   — RDS-managed; holds host, port,
 *      dbname, username, password. Rotated by RDS, never edited.
 *   2. {projectName}/config       — manual; holds LITELLM_MASTER_KEY
 *      (auto-gen), Redis endpoint, and AKSK_{1,2} placeholders.
 *
 * The ExternalSecret in ClusterStack pulls from both and uses ESO
 * templating to build DATABASE_URL at sync time. This avoids leaking
 * the RDS password into CloudFormation state or the litellm config
 * secret directly.
 *
 * Deployer must `aws secretsmanager update-secret` to fill the AKSK
 * placeholders before LiteLLM pods can reach Bedrock.
 */
export class DataStack extends cdk.Stack {
  public readonly litellmSecret: secretsmanager.ISecret;
  public readonly rdsSecret: secretsmanager.ISecret;
  public readonly redisAuthSecret: secretsmanager.ISecret;
  public readonly saltSecret: secretsmanager.ISecret;
  public readonly logsBucket: s3.IBucket;
  public readonly redisHost: string;
  public readonly databaseName: string;
  public readonly rdsSecurityGroup: ec2.ISecurityGroup;
  public readonly redisSecurityGroup: ec2.ISecurityGroup;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.databaseName = props.projectName;

    // Postgres engine version: prefer the region-specific version discovered by
    // scripts/init-env.ts (RDS versions differ per region — e.g. ap-southeast-1
    // has no 16.8). Falls back to 16.13 if context is absent. of() takes any
    // version string so we're not bound to CDK's PostgresEngineVersion constants.
    const pgVersionStr =
      (this.node.tryGetContext('postgresVersion') as string) ?? '16.13';

    // ------------------------------------------------------------
    // RDS Postgres — Multi-AZ, daily backup + PITR (30 days)
    // ------------------------------------------------------------
    const rdsSg = new ec2.SecurityGroup(this, 'RdsSg', {
      vpc: props.vpc,
      description: 'Allow PostgreSQL from EKS shared node SG',
      // RDS only listens; no outbound needed (replies ride the established
      // connection). Enhanced monitoring/PI run on the RDS service side, not
      // through this SG. Least-privilege.
      allowAllOutbound: false,
    });
    rdsSg.addIngressRule(
      props.sharedNodeSecurityGroup,
      ec2.Port.tcp(5432),
      'Postgres from EKS nodes',
    );

    const rdsInstance = new rds.DatabaseInstance(this, 'Postgres', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.of(pgVersionStr, pgVersionStr.split('.')[0]),
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.M6G,
        ec2.InstanceSize.LARGE,
      ),
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      databaseName: props.projectName,
      credentials: rds.Credentials.fromGeneratedSecret(props.projectName, {
        secretName: `${this.region}-${props.projectName}/rds-master`,
      }),
      multiAz: true,
      allocatedStorage: 100,
      maxAllocatedStorage: 500,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(30),
      preferredBackupWindow: '03:00-04:00',
      preferredMaintenanceWindow: 'sun:04:00-sun:05:00',
      copyTagsToSnapshot: true,
      deletionProtection: true,
      enablePerformanceInsights: true,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      monitoringInterval: cdk.Duration.seconds(60),
      cloudwatchLogsExports: ['postgresql', 'upgrade'],
      autoMinorVersionUpgrade: true,
      securityGroups: [rdsSg],
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    this.rdsSecret = rdsInstance.secret!;

    // ------------------------------------------------------------
    // ElastiCache Redis 7.1 — Multi-AZ, encryption at rest
    // ------------------------------------------------------------
    const redisSg = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc: props.vpc,
      description: 'Allow Redis from EKS shared node SG',
      // Redis only listens; no outbound needed (replies ride the established
      // connection, unaffected by egress rules). Least-privilege.
      allowAllOutbound: false,
    });
    redisSg.addIngressRule(
      props.sharedNodeSecurityGroup,
      ec2.Port.tcp(6379),
      'Redis from EKS nodes',
    );

    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: `${props.projectName} redis subnet group`,
      subnetIds: props.vpc.privateSubnets.map((s) => s.subnetId),
      cacheSubnetGroupName: `${this.region}-${props.projectName}-redis`,
    });

    // ElastiCache AUTH token. Required because the litellm config uses
    // ssl:true + REDIS_PASSWORD, and ElastiCache AUTH only works WITH transit
    // encryption. Auto-generated and stored as a JSON secret with a single
    // `password` key. ElastiCache references it as its authToken, and ESO
    // syncs the SAME secret into the litellm pod's REDIS_PASSWORD (see
    // ExternalSecret in ClusterStack) — so on rotation, ESO re-syncs every
    // refresh interval and there is NO drift. The token is NOT embedded into
    // the config secret (a static dynamic-ref would not follow rotation).
    //
    // JSON (vs a plain-string secret) makes ESO `extract` deterministic: the
    // key is `redis.password` after rewrite, consistent with config.*/rds.*.
    // Constraints: 16-128 chars, no spaces; excludePunctuation -> alphanumeric.
    this.redisAuthSecret = new secretsmanager.Secret(this, 'RedisAuthToken', {
      secretName: `${this.region}-${props.projectName}/redis-auth`,
      description: 'ElastiCache AUTH token (synced to litellm REDIS_PASSWORD via ESO)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({}),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 64,
      },
    });

    const redis = new elasticache.CfnReplicationGroup(this, 'Redis', {
      replicationGroupId: `${this.region}-${props.projectName}-redis-prod`,
      replicationGroupDescription: 'LiteLLM Redis for rate limiting and routing state',
      engine: 'redis',
      engineVersion: '7.1',
      cacheNodeType: 'cache.t4g.small',
      numCacheClusters: 2,
      automaticFailoverEnabled: true,
      multiAzEnabled: true,
      port: 6379,
      atRestEncryptionEnabled: true,
      // Transit encryption ON so the litellm config's ssl:true handshake
      // succeeds, and so AUTH can be used. authToken references the secret
      // via a CFN dynamic reference ({{resolve:secretsmanager:...}}) — the
      // plaintext token never lands in the template.
      transitEncryptionEnabled: true,
      authToken: this.redisAuthSecret
        .secretValueFromJson('password')
        .unsafeUnwrap(),
      cacheSubnetGroupName: redisSubnetGroup.ref,
      securityGroupIds: [redisSg.securityGroupId],
      snapshotRetentionLimit: 3,
      snapshotWindow: '02:00-03:00',
      preferredMaintenanceWindow: 'sun:03:00-sun:04:00',
    });
    redis.addDependency(redisSubnetGroup);

    this.redisHost = redis.attrPrimaryEndPointAddress;

    // ------------------------------------------------------------
    // S3 logs bucket — lifecycle 30d→IA, 90d→Glacier, 365d→delete
    // ------------------------------------------------------------
    this.logsBucket = new s3.Bucket(this, 'LogsBucket', {
      bucketName: `${props.projectName}-logs-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'expire-old-logs',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
          expiration: cdk.Duration.days(365),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ------------------------------------------------------------
    // LITELLM_SALT_KEY — REFERENCED from an externally-managed secret.
    //
    // SALT encrypts virtual keys / provider creds stored in the DB. It must be
    // a real random value (never CHANGE_ME) and, once set, must NEVER change —
    // rotating it makes every key already in the DB undecryptable.
    //
    // Because of that "never change" property, the SALT secret is deliberately
    // NOT created/owned by CDK: we don't want a CloudFormation replacement or
    // accidental regeneration to ever brick the DB-stored keys. Instead it is
    // created ONCE, out-of-band, and CDK only references it (read-only).
    //
    //   Create it before the first deploy (matches the upstream guide's
    //   `litellm/salt-key` manual step):
    //     SALT=$(openssl rand -hex 16)   # 32 chars
    //     aws secretsmanager create-secret \
    //       --name "<region>-<proj>/salt" \
    //       --description "LiteLLM SALT key (encrypts DB-stored virtual keys; never rotate)" \
    //       --secret-string "{\"LITELLM_SALT_KEY\":\"$SALT\"}" --region <region>
    //     # back up $SALT somewhere safe — losing it bricks every DB-stored key.
    //
    // ESO syncs it into the litellm pod via a 4th dataFrom (see ClusterStack
    // ExternalSecret, `salt.LITELLM_SALT_KEY`).
    // ------------------------------------------------------------
    this.saltSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'LitellmSaltKey',
      `${this.region}-${props.projectName}/salt`,
    );

    // ------------------------------------------------------------
    // Secrets Manager — litellm config secret (separate from RDS).
    //   LITELLM_MASTER_KEY:  auto-generated, never replaced.
    //   REDIS_HOST/PORT:  resolved at deploy time.
    //   LITELLM_SALT_KEY:  NOT here — lives in its own secret (created by hand BEFORE first deploy; see the saltSecret comment above).
    //   Everything below tagged CHANGE_ME is a placeholder filled AFTER deploy
    //   by `./scripts/deploy.sh post` (or manual update-secret):
    //     - GENERIC_CLIENT_ID / GENERIC_CLIENT_SECRET: Cognito UI-client
    //       id/secret (created in ClusterStack; written here post-deploy).
    //     - BEDROCK_MANTLE_API_KEY / GEMINI_API_KEY: upstream provider keys.
    //     - UI_PASSWORD: admin UI password (unused once Cognito SSO is on).
    //
    // The ExternalSecret in ClusterStack assembles the final k8s Secret from
    // FOUR sources: this config secret, the RDS-managed secret (DATABASE_URL,
    // built k8s-side), the redis-auth secret (REDIS_PASSWORD), and the salt
    // secret (LITELLM_SALT_KEY). REDIS_PASSWORD and SALT are deliberately NOT
    // in this config secret so their rotation/stability is managed independently.
    // ------------------------------------------------------------
    // IMPORTANT — keep secretStringTemplate 100% STATIC (no deploy-computed
    // values like this.redisHost). CFN regenerates a GenerateSecretString
    // secret whenever its template CONTENT changes; embedding a computed value
    // (redisHost) once caused a stack update to regenerate the whole secret,
    // resetting hand-filled creds (SSO client id/secret, Mantle key) back to
    // CHANGE_ME AND minting a new LITELLM_MASTER_KEY. So:
    //   - REDIS_HOST/PORT are NOT here anymore. ClusterStack's ExternalSecret
    //     injects REDIS_HOST directly from props.redisHost (string interp),
    //     not via config.REDIS_HOST. One less moving part in this template.
    //   - applyRemovalPolicy RETAIN + ignore value drift below so a regenerate
    //     can never silently wipe operator-filled values again.
    // After deploy, fill the CHANGE_ME values once (see post-deploy-singapore.md).
    this.litellmSecret = new secretsmanager.Secret(this, 'LitellmConfig', {
      secretName: `${this.region}-${props.projectName}/config`,
      description: 'LiteLLM proxy secrets (master key, SSO, providers)',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          // REDIS_HOST/PORT: injected by ClusterStack ExternalSecret from
          // props.redisHost (not stored here — keeps this template static).
          // REDIS_PASSWORD / LITELLM_SALT_KEY: separate secrets (see above).
          GENERIC_CLIENT_ID: 'CHANGE_ME',
          GENERIC_CLIENT_SECRET: 'CHANGE_ME',
          BEDROCK_MANTLE_API_KEY: 'CHANGE_ME',
          GEMINI_API_KEY: 'CHANGE_ME',
          UI_PASSWORD: 'CHANGE_ME',
        }),
        generateStringKey: 'LITELLM_MASTER_KEY',
        excludePunctuation: true,
        passwordLength: 32,
      },
      // RETAIN so a stack delete never drops the secret. Combined with the
      // now-static template, CFN won't regenerate it on routine updates.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.rdsSecurityGroup = rdsSg;
    this.redisSecurityGroup = redisSg;

    new cdk.CfnOutput(this, 'LitellmSecretArn', { value: this.litellmSecret.secretArn });
    new cdk.CfnOutput(this, 'LitellmSecretName', { value: this.litellmSecret.secretName });
    new cdk.CfnOutput(this, 'SaltSecretName', { value: this.saltSecret.secretName });
    new cdk.CfnOutput(this, 'RdsSecretArn', { value: this.rdsSecret.secretArn });
    new cdk.CfnOutput(this, 'RdsEndpoint', { value: rdsInstance.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'RedisEndpoint', { value: this.redisHost });
    new cdk.CfnOutput(this, 'LogsBucketName', { value: this.logsBucket.bucketName });
  }
}
