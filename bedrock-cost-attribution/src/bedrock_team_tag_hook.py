"""
Bedrock per-team cost attribution hook for LiteLLM.

On every `bedrock/` call, assume a dedicated exec role with an STS Session Tag
`team=<team_alias>` and inject the temporary credentials into the request. AWS
records the assumed-role principal in CUR 2.0's `line_item_iam_principal`, and
the session tag surfaces as `iamPrincipal/team`, so Bedrock spend can be split
by team in Cost Explorer.

Mechanism (AWS IAM principal-based cost attribution, GA 2026-04):
  litellm-sa (IRSA) --AssumeRole + TagSession(team=X)--> bedrock-exec role
  --> Bedrock InvokeModel runs as assumed-role/bedrock-exec/litellm-<team>
  --> CUR: iamPrincipal/team = X

Design:
  - Team-only for now. To extend to key/user later, add more entries to the
    `tags` list below (STS allows up to 50 session tags) and widen the cache key.
  - Per-team credential cache (55 min) to avoid hitting STS on every request
    (STS AssumeRole limit ~500/s/account). Temp creds last 1h; refresh at 55m.
  - Requests with NO team_alias are passed through untouched (no AssumeRole),
    so they keep working and fall under the pod's own IRSA principal in CUR.
  - Uses only boto3 + stdlib (both already in the image).

Env:
  BEDROCK_EXEC_ROLE_ARN  - the exec role to assume (required to activate)
  AWS_REGION             - region for the STS client (defaults to pod region)
"""
import os
import re
import time
import threading

import boto3
from litellm._logging import verbose_logger
from litellm.integrations.custom_logger import CustomLogger

EXEC_ROLE_ARN = os.environ.get("BEDROCK_EXEC_ROLE_ARN", "")
# Temp creds live 1h; refresh a little early.
_CRED_TTL_SECONDS = 55 * 60
# team_alias may contain chars STS tag values reject; tag values allow
# [a-zA-Z0-9 _.:/=+@-], 256 max. Normalize anything else to '_'.
_TAG_VALUE_RE = re.compile(r"[^a-zA-Z0-9_.:/=+@-]")


def _safe_tag_value(value: str) -> str:
    return _TAG_VALUE_RE.sub("_", value)[:256]


class BedrockTeamTagHook(CustomLogger):
    def __init__(self):
        super().__init__()
        self._sts = boto3.client("sts")
        # cache: team -> (creds_dict, expiry_epoch)
        self._cache = {}
        self._lock = threading.Lock()

    def _assume_for_team(self, team: str) -> dict:
        now = time.time()
        with self._lock:
            cached = self._cache.get(team)
            if cached and cached[1] > now:
                return cached[0]
        # Cache miss / expired — assume the exec role with the team session tag.
        session_name = _safe_tag_value(f"litellm-{team}")[:64]
        resp = self._sts.assume_role(
            RoleArn=EXEC_ROLE_ARN,
            RoleSessionName=session_name,
            Tags=[{"Key": "team", "Value": _safe_tag_value(team)}],
            DurationSeconds=3600,
        )
        c = resp["Credentials"]
        creds = {
            "aws_access_key_id": c["AccessKeyId"],
            "aws_secret_access_key": c["SecretAccessKey"],
            "aws_session_token": c["SessionToken"],
        }
        with self._lock:
            self._cache[team] = (creds, now + _CRED_TTL_SECONDS)
        return creds

    async def async_pre_call_hook(
        self, user_api_key_dict, cache, data, call_type
    ):
        # Only act when an exec role is configured.
        if not EXEC_ROLE_ARN:
            return data
        team = getattr(user_api_key_dict, "team_alias", None)
        model = str(data.get("model", ""))
        verbose_logger.info(
            f"BedrockTeamTagHook.pre_call call_type={call_type} model={model!r} "
            f"team_alias={team!r}"
        )
        if not team:
            # No team → pass through (keeps untagged requests working).
            return data
        # Inject assumed-role creds for ALL team requests. At the proxy pre-call
        # hook, data["model"] is the PUBLIC model_name (e.g. 'bedrock-nova-pro'),
        # not the litellm_params 'bedrock/...' id, and custom_llm_provider is not
        # yet resolved — so we cannot reliably detect bedrock here. For non-bedrock
        # backends the injected aws_* keys are simply ignored, so this is safe.
        # Also tag the Bedrock invocation log itself via requestMetadata, so the
        # team is queryable in near-real-time from CloudWatch model-invocation
        # logs (the STS session tag only surfaces in CUR 2.0, hours later).
        # LiteLLM validates + forwards this into the Converse request body's
        # top-level `requestMetadata`, which Bedrock records in the log. Only
        # the Converse path honors it; non-bedrock backends ignore it safely.
        md = dict(data.get("requestMetadata") or {})
        md["team"] = _safe_tag_value(team)
        data["requestMetadata"] = md
        try:
            creds = self._assume_for_team(team)
            data["aws_access_key_id"] = creds["aws_access_key_id"]
            data["aws_secret_access_key"] = creds["aws_secret_access_key"]
            data["aws_session_token"] = creds["aws_session_token"]
        except Exception as e:
            # Never fail the request over attribution — log and pass through.
            verbose_logger.warning(
                f"BedrockTeamTagHook: assume_role failed for team={team!r}: {e}"
            )
        return data


# Module-level instance referenced by config.yaml callbacks:
#   callbacks: ["bedrock_team_tag_hook.bedrock_team_tag_hook_instance"]
bedrock_team_tag_hook_instance = BedrockTeamTagHook()
