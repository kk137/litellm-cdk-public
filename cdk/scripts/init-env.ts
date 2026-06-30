#!/usr/bin/env npx ts-node
/**
 * Auto-discovers AWS environment parameters and writes cdk.context.local.json.
 * Run before `cdk synth/deploy` to populate context automatically.
 *
 * Usage:
 *   npx ts-node scripts/init-env.ts --domain example.com [--region ap-southeast-1] [--host-prefix litellm-sg] [--max-azs 2]
 */
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { EC2Client, DescribeAvailabilityZonesCommand, DescribeInstanceTypeOfferingsCommand } from '@aws-sdk/client-ec2';
import { Route53Client, ListHostedZonesByNameCommand } from '@aws-sdk/client-route-53';
import { BedrockClient, ListInferenceProfilesCommand, ListInferenceProfilesCommandOutput } from '@aws-sdk/client-bedrock';
import { RDSClient, DescribeDBEngineVersionsCommand } from '@aws-sdk/client-rds';
import * as fs from 'fs';
import * as path from 'path';

// Karpenter NodePool instance types — keep in sync with cluster-stack.ts.
// init-env intersects these with what the region's AZs actually offer, so a
// zone with no Graviton capacity is dropped from nodepoolZones up front
// (avoids pods stuck Pending — see post-deploy docs problem #3).
const NODEPOOL_INSTANCE_TYPES = ['r6g.large', 'r7g.large'];

// ─── Arg Parsing ────────────────────────────────────────────────────────────

function parseArgs(): { domain: string; region: string; hostPrefix: string; maxAzs: number; adminPrincipals?: string[] } {
  const args = process.argv.slice(2);
  let domain = '';
  let region = process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || '';
  let hostPrefix = 'litellm';
  let maxAzs = 2; // verification default: 2 AZs (matches VPC maxAzs:2). Raise to 3 for prod HA.
  let adminPrincipals: string[] | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--domain': domain = args[++i]; break;
      case '--region': region = args[++i]; break;
      case '--host-prefix': hostPrefix = args[++i]; break;
      case '--max-azs': maxAzs = parseInt(args[++i], 10); break;
      case '--admin-principals': adminPrincipals = JSON.parse(args[++i]); break;
    }
  }

  if (!domain) {
    console.error('Error: --domain is required');
    console.error('Usage: npx ts-node scripts/init-env.ts --domain <domain> [--region <region>] [--host-prefix <prefix>]');
    process.exit(1);
  }

  if (!region) {
    console.error('Error: --region is required (or set AWS_DEFAULT_REGION)');
    process.exit(1);
  }

  return { domain, region, hostPrefix, maxAzs, adminPrincipals };
}

// ─── Discovery Functions ────────────────────────────────────────────────────

async function discoverAccountId(region: string): Promise<{ accountId: string; callerArn: string }> {
  const client = new STSClient({ region });
  const resp = await client.send(new GetCallerIdentityCommand({}));
  return { accountId: resp.Account!, callerArn: resp.Arn! };
}

async function discoverAZs(region: string, maxAzs: number): Promise<string[]> {
  const client = new EC2Client({ region });

  const azResp = await client.send(new DescribeAvailabilityZonesCommand({
    Filters: [{ Name: 'state', Values: ['available'] }],
  }));
  const allZones = azResp.AvailabilityZones!.map(az => az.ZoneName!).sort();

  // Keep only AZs that actually offer at least one NodePool instance type.
  // describe-instance-type-offerings returns the (instance-type, AZ) pairs that
  // exist; an AZ missing all our Graviton types can't host litellm nodes and
  // would strand pods in Pending (problem #3). Drop it before CDK ever sees it.
  const offerResp = await client.send(new DescribeInstanceTypeOfferingsCommand({
    LocationType: 'availability-zone',
    Filters: [{ Name: 'instance-type', Values: NODEPOOL_INSTANCE_TYPES }],
  }));
  const zonesWithCapacity = new Set(
    (offerResp.InstanceTypeOfferings || []).map(o => o.Location!)
  );

  const usable = allZones.filter(z => zonesWithCapacity.has(z));
  if (usable.length < maxAzs) {
    console.warn(
      `         WARNING: only ${usable.length} AZ(s) offer NodePool instance types ` +
      `(${NODEPOOL_INSTANCE_TYPES.join(', ')}); requested ${maxAzs}. Using ${usable.length}.`
    );
  }
  // Take the first `maxAzs` usable zones (verification default: 2).
  return usable.slice(0, maxAzs);
}

async function discoverPostgresVersion(region: string): Promise<string | undefined> {
  // RDS engine versions differ per region (e.g. ap-southeast-1 has no 16.8).
  // Pick the highest available 16.x so the version is never hardcoded wrong.
  const client = new RDSClient({ region });
  const resp = await client.send(new DescribeDBEngineVersionsCommand({
    Engine: 'postgres',
  }));
  const v16 = (resp.DBEngineVersions || [])
    .map(v => v.EngineVersion!)
    .filter(v => v.startsWith('16.'))
    .sort((a, b) => {
      const na = parseInt(a.split('.')[1], 10);
      const nb = parseInt(b.split('.')[1], 10);
      return nb - na; // descending
    });
  return v16[0]; // highest 16.x, or undefined if none
}

async function discoverHostedZone(domain: string): Promise<string> {
  const client = new Route53Client({ region: 'us-east-1' }); // Route53 is global

  // Try progressively shorter domain suffixes
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    const resp = await client.send(new ListHostedZonesByNameCommand({ DNSName: candidate, MaxItems: 1 }));
    const zones = resp.HostedZones || [];
    const match = zones.find(z => z.Name === `${candidate}.`);
    if (match) {
      return match.Id!.replace('/hostedzone/', '');
    }
  }

  throw new Error(`No hosted zone found for domain: ${domain}. Create one first or pass hostedZoneId manually via -c.`);
}

async function discoverBedrockProfiles(region: string): Promise<string[]> {
  const client = new BedrockClient({ region });
  const profiles: string[] = [];
  let nextToken: string | undefined;

  do {
    const resp: ListInferenceProfilesCommandOutput = await client.send(
      new ListInferenceProfilesCommand({ maxResults: 100, nextToken })
    );
    for (const profile of resp.inferenceProfileSummaries || []) {
      if (profile.inferenceProfileId) {
        profiles.push(profile.inferenceProfileId);
      }
    }
    nextToken = resp.nextToken;
  } while (nextToken);

  return profiles;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { domain, region, hostPrefix, maxAzs, adminPrincipals } = parseArgs();

  console.log(`\n=== LiteLLM CDK: Auto-discovering parameters ===`);
  console.log(`  Domain: ${domain}`);
  console.log(`  Region: ${region}`);
  console.log(`  Prefix: ${hostPrefix}`);
  console.log(`  Max AZs: ${maxAzs}\n`);

  // 1. Account ID
  console.log('  [1/5] Discovering account identity...');
  const { accountId, callerArn } = await discoverAccountId(region);
  console.log(`         Account: ${accountId} (${callerArn})`);

  // 2. Availability Zones (only those with NodePool instance capacity)
  console.log('  [2/5] Discovering availability zones...');
  const nodepoolZones = await discoverAZs(region, maxAzs);
  console.log(`         AZs: ${nodepoolZones.join(', ')}`);

  // 3. Route53 Hosted Zone
  console.log('  [3/5] Discovering hosted zone...');
  let hostedZoneId: string;
  try {
    hostedZoneId = await discoverHostedZone(domain);
    console.log(`         Zone: ${hostedZoneId}`);
  } catch (e: any) {
    console.warn(`         WARNING: ${e.message}`);
    console.warn(`         Set hostedZoneId manually in cdk.context.json or via -c`);
    hostedZoneId = 'CHANGE_ME';
  }

  // 4. RDS Postgres engine version (highest 16.x available in region)
  console.log('  [4/5] Discovering RDS Postgres version...');
  const postgresVersion = await discoverPostgresVersion(region);
  console.log(`         Postgres: ${postgresVersion ?? '(none found — falling back to CDK default)'}`);

  // 5. Bedrock Inference Profiles
  console.log('  [5/5] Discovering Bedrock inference profiles...');
  const bedrockProfiles = await discoverBedrockProfiles(region);
  console.log(`         Found ${bedrockProfiles.length} profiles`);

  // Resolve admin principals
  const resolvedAdminPrincipals = adminPrincipals || [callerArn];

  // Write context
  const context: Record<string, any> = {
    domain,
    hostedZoneId,
    hostPrefix,
    bedrockRegion: region,
    maxAzs,
    nodepoolZones,
    clusterAdminPrincipals: resolvedAdminPrincipals,
    _bedrockProfiles: bedrockProfiles,
  };
  if (postgresVersion) context.postgresVersion = postgresVersion;

  const outPath = path.join(process.cwd(), 'cdk.context.local.json');
  fs.writeFileSync(outPath, JSON.stringify(context, null, 2) + '\n');

  console.log(`\n  ✅ Written: ${outPath}`);
  console.log(`\n  Next steps:`);
  console.log(`    cp cdk.context.local.json cdk.context.json`);
  console.log(`    npx cdk synth`);
  console.log(`    npx cdk deploy --all\n`);
}

main().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
