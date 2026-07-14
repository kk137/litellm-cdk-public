import * as yaml from 'js-yaml';

// ─── Model Catalog ──────────────────────────────────────────────────────────
// Defines all models we want to expose. The prefix (us./global./apac.) is
// resolved at synth time based on what Bedrock actually offers in the region.

interface BedrockModel {
  name: string;
  bedrockId: string;
  prefixPreference: string[]; // try in order; first match wins
  extraParams?: Record<string, any>;
  modelInfo?: Record<string, any>;
  variants?: Array<{
    suffix: string;
    extraParams?: Record<string, any>;
    modelInfo?: Record<string, any>;
  }>;
}

interface StaticModel {
  name: string;
  litellmParams: Record<string, any>;
  modelInfo?: Record<string, any>;
}

const BEDROCK_MODELS: BedrockModel[] = [
  {
    name: 'claude-fable-5',
    bedrockId: 'anthropic.claude-fable-5',
    prefixPreference: ['us', 'global'],
    extraParams: { custom_llm_provider: 'bedrock', stream_timeout: 900, input_cost_per_token: 0.00001, output_cost_per_token: 0.00005, cache_creation_input_token_cost: 0.0000125, cache_read_input_token_cost: 0.000001, cache_creation_input_token_cost_above_1hr: 0.00002 },
    modelInfo: { supports_prompt_caching: true, max_input_tokens: 1000000, max_output_tokens: 128000 },
    variants: [{ suffix: '[1m]', extraParams: { custom_llm_provider: 'bedrock', stream_timeout: 900, input_cost_per_token: 0.00001, output_cost_per_token: 0.00005, cache_creation_input_token_cost: 0.0000125, cache_read_input_token_cost: 0.000001, cache_creation_input_token_cost_above_1hr: 0.00002 }, modelInfo: { supports_prompt_caching: true, max_input_tokens: 1000000, max_output_tokens: 128000 } }],
  },
  {
    name: 'claude-opus-4-8',
    bedrockId: 'anthropic.claude-opus-4-8',
    prefixPreference: ['us', 'global'],
    extraParams: { stream_timeout: 900 },
    modelInfo: { max_input_tokens: 1000000, max_output_tokens: 128000 },
  },
  {
    name: 'claude-opus-4-7',
    bedrockId: 'anthropic.claude-opus-4-7',
    prefixPreference: ['us', 'global'],
    extraParams: { stream_timeout: 900 },
    modelInfo: { max_input_tokens: 1000000, max_output_tokens: 128000 },
  },
  {
    name: 'claude-opus-4-6',
    bedrockId: 'anthropic.claude-opus-4-6-v1',
    prefixPreference: ['us', 'global'],
    extraParams: { stream_timeout: 900 },
    modelInfo: { max_input_tokens: 1000000, max_output_tokens: 128000 },
  },
  {
    // Launch pricing $2/$10 per M tokens through 2026-08-31, then standard $3/$15 (anthropic.com/claude/sonnet).
    name: 'claude-sonnet-5',
    bedrockId: 'anthropic.claude-sonnet-5',
    prefixPreference: ['us', 'global'],
    extraParams: { stream_timeout: 900, input_cost_per_token: 0.000002, output_cost_per_token: 0.00001 },
    modelInfo: { max_input_tokens: 1000000, max_output_tokens: 128000 },
  },
  {
    name: 'claude-sonnet-4-6',
    bedrockId: 'anthropic.claude-sonnet-4-6',
    prefixPreference: ['us', 'global'],
    extraParams: { stream_timeout: 900 },
    variants: [{
      suffix: '[1m]',
      extraParams: { stream_timeout: 900, extra_headers: { 'anthropic-beta': 'context-1m-2025-08-07' } },
      modelInfo: { max_input_tokens: 1000000, max_output_tokens: 128000 },
    }],
  },
  {
    name: 'claude-haiku-4-5',
    bedrockId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
    prefixPreference: ['us', 'global'],
    extraParams: { drop_params: true, additional_drop_params: ['thinking'] },
  },
  {
    name: 'bedrock-nova-premier',
    bedrockId: 'amazon.nova-premier-v1:0',
    prefixPreference: ['us', 'apac', 'global'],
  },
  {
    name: 'bedrock-nova-pro',
    bedrockId: 'amazon.nova-pro-v1:0',
    prefixPreference: ['us', 'apac', 'global'],
  },
  {
    name: 'bedrock-nova-lite',
    bedrockId: 'amazon.nova-lite-v1:0',
    prefixPreference: ['us', 'apac', 'global'],
  },
  {
    name: 'bedrock-nova-micro',
    bedrockId: 'amazon.nova-micro-v1:0',
    prefixPreference: ['us', 'apac', 'global'],
  },
];

const MANTLE_MODELS: StaticModel[] = [
  {
    name: 'gpt-5.5',
    litellmParams: { model: 'openai/openai.gpt-5.5', api_base: 'https://bedrock-mantle.us-east-2.api.aws/openai/v1', api_key: 'os.environ/BEDROCK_MANTLE_API_KEY', drop_params: true },
    modelInfo: { max_input_tokens: 272000, input_cost_per_token: 0.0000055, input_cost_per_token_cache_hit: 0.00000055, output_cost_per_token: 0.000033 },
  },
  {
    name: 'gpt-5.4',
    litellmParams: { model: 'openai/openai.gpt-5.4', api_base: 'https://bedrock-mantle.us-east-2.api.aws/openai/v1', api_key: 'os.environ/BEDROCK_MANTLE_API_KEY', drop_params: true },
    modelInfo: { max_input_tokens: 272000, input_cost_per_token: 0.00000275, input_cost_per_token_cache_hit: 0.000000275, output_cost_per_token: 0.0000165 },
  },
  {
    // second gpt-5.4 entry with us-west-2 endpoint for load balancing
    name: 'gpt-5.4',
    litellmParams: { model: 'openai/openai.gpt-5.4', api_base: 'https://bedrock-mantle.us-west-2.api.aws/openai/v1', api_key: 'os.environ/BEDROCK_MANTLE_API_KEY', drop_params: true },
    modelInfo: { max_input_tokens: 272000, input_cost_per_token: 0.00000275, input_cost_per_token_cache_hit: 0.000000275, output_cost_per_token: 0.0000165 },
  },
  {
    name: 'grok-4.3',
    litellmParams: { model: 'openai/xai.grok-4.3', api_base: 'https://bedrock-mantle.us-west-2.api.aws/openai/v1', api_key: 'os.environ/BEDROCK_MANTLE_API_KEY', drop_params: true },
    modelInfo: { max_input_tokens: 1000000, input_cost_per_token: 0.00000125, output_cost_per_token: 0.0000025 },
  },
];

const GEMINI_MODELS: StaticModel[] = [
  { name: 'gemini-3.5-flash', litellmParams: { model: 'gemini/gemini-3.5-flash', api_key: 'os.environ/GEMINI_API_KEY' } },
  { name: 'gemini-3.1-flash-image', litellmParams: { model: 'gemini/gemini-3.1-flash-image', api_key: 'os.environ/GEMINI_API_KEY' } },
];

const CODEX_ALIASES: StaticModel[] = [
  { name: 'codex-auto-review', litellmParams: { model: 'openai/openai.gpt-5.5', api_base: 'https://bedrock-mantle.us-east-2.api.aws/openai/v1', api_key: 'os.environ/BEDROCK_MANTLE_API_KEY', drop_params: true } },
  { name: 'gpt-5.4-mini', litellmParams: { model: 'openai/openai.gpt-5.4', api_base: 'https://bedrock-mantle.us-east-2.api.aws/openai/v1', api_key: 'os.environ/BEDROCK_MANTLE_API_KEY', drop_params: true } },
  { name: 'gpt-5', litellmParams: { model: 'openai/openai.gpt-5.5', api_base: 'https://bedrock-mantle.us-east-2.api.aws/openai/v1', api_key: 'os.environ/BEDROCK_MANTLE_API_KEY', drop_params: true } },
  { name: 'gpt-5-codex', litellmParams: { model: 'openai/openai.gpt-5.5', api_base: 'https://bedrock-mantle.us-east-2.api.aws/openai/v1', api_key: 'os.environ/BEDROCK_MANTLE_API_KEY', drop_params: true } },
];

// ─── Prefix Resolution ──────────────────────────────────────────────────────

function resolveBedrockModel(
  model: BedrockModel,
  availableProfiles: string[],
  bedrockRegion: string,
): any[] {
  let resolvedId: string | null = null;

  for (const prefix of model.prefixPreference) {
    const candidate = `${prefix}.${model.bedrockId}`;
    if (availableProfiles.includes(candidate)) {
      resolvedId = candidate;
      break;
    }
  }

  // Fallback: if no profiles provided (user skipped init-env), use global. prefix
  if (!resolvedId && availableProfiles.length === 0) {
    resolvedId = `global.${model.bedrockId}`;
  }

  if (!resolvedId) return []; // model unavailable in this region

  const entries: any[] = [];

  // Main entry
  const litellmParams: any = {
    model: `bedrock/${resolvedId}`,
    aws_region_name: bedrockRegion,
    ...model.extraParams,
  };
  const entry: any = { model_name: model.name, litellm_params: litellmParams };
  if (model.modelInfo) entry.model_info = model.modelInfo;
  entries.push(entry);

  // Variants (e.g., [1m])
  if (model.variants) {
    for (const variant of model.variants) {
      const vParams: any = {
        model: `bedrock/${resolvedId}`,
        aws_region_name: bedrockRegion,
        ...variant.extraParams,
      };
      const vEntry: any = { model_name: `${model.name}${variant.suffix}`, litellm_params: vParams };
      if (variant.modelInfo) vEntry.model_info = variant.modelInfo;
      entries.push(vEntry);
    }
  }

  return entries;
}

// ─── Config Builder ─────────────────────────────────────────────────────────

export interface BuildConfigOptions {
  bedrockRegion: string;
  s3BucketName: string;
  availableProfiles: string[];
  /**
   * WebSearch interception backend.
   *   'searxng'   — built-in websearch_interception callback → self-hosted
   *                 SearXNG (default; fully in-cluster, region-agnostic).
   *   'agentcore' — custom callback subclass (agentcore_websearch.py) that
   *                 overrides _execute_search to call Amazon Bedrock AgentCore
   *                 Web Search. Requires: (a) the agentcore_websearch.py file
   *                 mounted into /app/config (same dir as config.yaml — LiteLLM's
   *                 get_instance_fn resolves callback modules relative to the
   *                 config dir, ignoring PYTHONPATH); (b) AGENTCORE_WS_* env on
   *                 the pod; (c) the AgentCore gateway (us-east-1 only).
   *                 The custom class carries enabled_providers in code, so no
   *                 websearch_interception_params block is emitted.
   */
  websearchBackend?: 'searxng' | 'agentcore';
  /**
   * When true, prepend the per-team Bedrock cost-attribution callback
   * (`bedrock_team_tag_hook.bedrock_team_tag_hook_instance`) to the callbacks
   * list. The hook .py must be shipped into /app/config (same place as the
   * agentcore callback) and BEDROCK_EXEC_ROLE_ARN must be on the pod. This is
   * what actually ACTIVATES attribution — shipping the file alone does nothing.
   */
  enableBedrockCostAttribution?: boolean;
}

export function buildLitellmConfig(opts: BuildConfigOptions): string {
  const { bedrockRegion, s3BucketName, availableProfiles } = opts;
  const websearchBackend = opts.websearchBackend ?? 'searxng';

  // Build model_list
  const modelList: any[] = [];

  // Bedrock models (dynamic prefix resolution)
  for (const model of BEDROCK_MODELS) {
    modelList.push(...resolveBedrockModel(model, availableProfiles, bedrockRegion));
  }

  // Gemini (always included)
  for (const m of GEMINI_MODELS) {
    const entry: any = { model_name: m.name, litellm_params: { ...m.litellmParams } };
    if (m.modelInfo) entry.model_info = m.modelInfo;
    modelList.push(entry);
  }

  // Mantle (always included — fixed US endpoints)
  for (const m of MANTLE_MODELS) {
    const entry: any = { model_name: m.name, litellm_params: { ...m.litellmParams } };
    if (m.modelInfo) entry.model_info = m.modelInfo;
    modelList.push(entry);
  }

  // Codex aliases (always included)
  for (const m of CODEX_ALIASES) {
    modelList.push({ model_name: m.name, litellm_params: { ...m.litellmParams } });
  }

  // Full config object
  const config: any = {
    model_list: modelList,

    router_settings: {
      routing_strategy: 'least-busy',
      num_retries: 3,
      retry_after: 5,
      timeout: 1200,
      allowed_fails: 2,
      cooldown_time: 60,
      fallbacks: [
        { 'gemini-3.5-flash': ['claude-sonnet-4-6'] },
        { 'gemini-3.1-flash-image': ['claude-sonnet-4-6'] },
        { 'claude-opus-4-8': ['claude-sonnet-4-6[1m]'] },
      ],
    },

    litellm_settings: {
      cache: true,
      cache_params: {
        type: 'redis',
        host: 'os.environ/REDIS_HOST',
        port: '6379',
        password: 'os.environ/REDIS_PASSWORD',
        ssl: true,
        ttl: 600,
        supported_call_types: ['acompletion', 'completion', 'embedding'],
      },
      // WebSearch callback: agentcore (custom subclass) or built-in searxng.
      // The agentcore class carries enabled_providers in code, so it needs no
      // websearch_interception_params block. The per-team cost-attribution hook
      // (when enabled) is prepended — it runs in async_pre_call_hook to inject
      // assumed-role creds before the request reaches the Bedrock client.
      callbacks: [
        ...(opts.enableBedrockCostAttribution
          ? ['bedrock_team_tag_hook.bedrock_team_tag_hook_instance']
          : []),
        // Codex (>=26.707 "Responses Lite") packs tools into a non-standard
        // {type:"additional_tools"} input item that Bedrock Mantle rejects
        // (400 "Invalid 'input'"; Codex issue #32086). This hook flattens it
        // into top-level `tools` in async_pre_call_hook. Always on: non-Codex
        // requests pass through untouched (no additional_tools item present).
        'codex_additional_tools_flatten.codex_additional_tools_flatten_instance',
        'prometheus',
        websearchBackend === 'agentcore'
          ? 'agentcore_websearch.agentcore_websearch_logger'
          : 'websearch_interception',
        's3_v2',
      ],
      ...(websearchBackend === 'searxng'
        ? {
            websearch_interception_params: {
              enabled_providers: ['bedrock', 'bedrock_converse'],
              search_tool_name: 'searxng-search',
            },
          }
        : {}),
      s3_callback_params: {
        s3_bucket_name: s3BucketName,
        s3_region_name: bedrockRegion,
      },
      set_verbose: false,
      json_logs: true,
    },

    search_tools: [
      {
        search_tool_name: 'searxng-search',
        litellm_params: { search_provider: 'searxng', api_base: 'http://searxng:8080' },
      },
    ],

    general_settings: {
      use_x_forwarded_for: true,
      master_key: 'os.environ/LITELLM_MASTER_KEY',
      database_url: 'os.environ/DATABASE_URL',
      store_model_in_db: true,
      database_connection_pool_limit: 10,
      database_connection_timeout: 30,
      allow_requests_on_db_unavailable: true,
      redis_host: 'os.environ/REDIS_HOST',
      redis_port: '6379',
      redis_password: 'os.environ/REDIS_PASSWORD',
      redis_ssl: true,
    },
  };

  return yaml.dump(config, { lineWidth: 120, noRefs: true, quotingType: '"' });
}
