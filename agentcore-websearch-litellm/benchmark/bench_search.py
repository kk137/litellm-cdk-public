#!/usr/bin/env python3
"""
搜索后端延迟/效果对比 benchmark —— 在 LiteLLM Pod 内运行。

对比同一 interception 位置（_execute_search 等价于 litellm.asearch）下三个后端：
  - exa_ai      : litellm.asearch(search_provider="exa_ai")     env: EXA_API_KEY
  - tavily      : litellm.asearch(search_provider="tavily")     env: TAVILY_API_KEY
  - agentcore   : 裸 SigV4 调 AgentCore MCP（走 Pod IRSA，无需 key）

延迟：每后端 × 每 query × N 轮，丢弃 warmup，算 p50/p95。
效果：所有结果落 results.jsonl，供人工并排评估。

⚠️ Key 只从环境变量读，绝不写进本文件。运行前：
     export EXA_API_KEY=...        # 测 exa 才需要
     export TAVILY_API_KEY=...     # 测 tavily 才需要
   测完 unset。AgentCore 用 Pod IRSA，无需任何 key。

用法（在 Pod 内）：
   python3 bench_search.py \
     --providers exa_ai,tavily,agentcore \
     --queries queries.txt \
     --runs 30 --warmup 3 --max-results 10 \
     --agentcore-mcp-url https://<GATEWAY_ID>.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp \
     --agentcore-region us-east-1 \
     --agentcore-tool web-search-tool___WebSearch
"""
import argparse, asyncio, csv, json, os, statistics, sys, time

# ---------- 统一结果结构 ----------
# 每次搜索返回: (latency_ms: float | None, results: list[dict], error: str | None)
# results 项统一为 {"title","url","snippet"}

# ---------- exa_ai / tavily：走 litellm.asearch ----------
async def search_litellm(provider: str, query: str, max_results: int):
    import litellm
    t0 = time.perf_counter()
    try:
        resp = await litellm.asearch(
            query=query, search_provider=provider, max_results=max_results,
        )
        ms = (time.perf_counter() - t0) * 1000
        results = [
            {"title": getattr(r, "title", ""), "url": getattr(r, "url", ""),
             "snippet": (getattr(r, "snippet", "") or "")[:500]}
            for r in (resp.results or [])
        ]
        return ms, results, None
    except Exception as e:
        return None, [], f"{type(e).__name__}: {e}"

# ---------- agentcore：裸 SigV4 调 MCP ----------
def _agentcore_call(query, max_results, mcp_url, region, tool_name):
    import urllib.request, boto3
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest
    payload = json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {"name": tool_name,
                   "arguments": {"query": query[:200], "maxResults": max_results}},
    })
    req = AWSRequest(method="POST", url=mcp_url, data=payload,
                     headers={"Content-Type": "application/json",
                              "Accept": "application/json, text/event-stream"})
    creds = boto3.Session().get_credentials()        # Pod 内 = IRSA
    SigV4Auth(creds, "bedrock-agentcore", region).add_auth(req)
    r = urllib.request.urlopen(
        urllib.request.Request(mcp_url, data=payload.encode(),
                               headers=dict(req.headers)), timeout=60)
    raw = r.read().decode()
    # MCP 可能返回 SSE（text/event-stream），取最后一个 data: 行
    if raw.lstrip().startswith("event:") or "data:" in raw.split("\n", 1)[0]:
        for line in raw.splitlines():
            if line.startswith("data:"):
                raw = line[5:].strip()
    obj = json.loads(raw)
    inner = json.loads(obj["result"]["content"][0]["text"])
    return [
        {"title": it.get("title", ""), "url": it.get("url", ""),
         "snippet": (it.get("text", "") or "")[:500]}
        for it in inner.get("results", [])
    ]

async def search_agentcore(query, max_results, mcp_url, region, tool_name):
    t0 = time.perf_counter()
    try:
        results = await asyncio.to_thread(
            _agentcore_call, query, max_results, mcp_url, region, tool_name)
        ms = (time.perf_counter() - t0) * 1000
        return ms, results, None
    except Exception as e:
        return None, [], f"{type(e).__name__}: {e}"

# ---------- 分发 ----------
async def run_one(provider, query, args):
    if provider == "agentcore":
        return await search_agentcore(query, args.max_results,
                                      args.agentcore_mcp_url, args.agentcore_region,
                                      args.agentcore_tool)
    return await search_litellm(provider, query, args.max_results)

def pctl(xs, p):
    if not xs: return None
    xs = sorted(xs); k = (len(xs) - 1) * p / 100
    f = int(k); c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--providers", default="exa_ai,tavily,agentcore")
    ap.add_argument("--queries", default="queries.txt")
    ap.add_argument("--runs", type=int, default=30)
    ap.add_argument("--warmup", type=int, default=3)
    ap.add_argument("--max-results", type=int, default=10)
    ap.add_argument("--agentcore-mcp-url", default=os.environ.get("AGENTCORE_WS_MCP_URL", ""))
    ap.add_argument("--agentcore-region", default=os.environ.get("AGENTCORE_WS_REGION", "us-east-1"))
    ap.add_argument("--agentcore-tool", default=os.environ.get("AGENTCORE_WS_TOOL_NAME", "web-search-tool___WebSearch"))
    ap.add_argument("--out-prefix", default="bench")
    args = ap.parse_args()

    providers = [p.strip() for p in args.providers.split(",") if p.strip()]
    queries = [l.strip() for l in open(args.queries, encoding="utf-8")
               if l.strip() and not l.lstrip().startswith("#")]

    # key / 前置自检（不打印 key 值）
    if "exa_ai" in providers and not os.environ.get("EXA_API_KEY"):
        sys.exit("缺 EXA_API_KEY，先 export 再跑（或从 --providers 去掉 exa_ai）")
    if "tavily" in providers and not os.environ.get("TAVILY_API_KEY"):
        sys.exit("缺 TAVILY_API_KEY，先 export 再跑（或从 --providers 去掉 tavily）")
    if "agentcore" in providers and not args.agentcore_mcp_url:
        sys.exit("缺 --agentcore-mcp-url（或 export AGENTCORE_WS_MCP_URL）")

    print(f"providers={providers}  queries={len(queries)}  runs={args.runs} "
          f"(warmup {args.warmup})  max_results={args.max_results}\n")

    lat_f = open(f"{args.out_prefix}.latency.csv", "w", newline="", encoding="utf-8")
    lat_w = csv.writer(lat_f); lat_w.writerow(["provider", "query", "run", "latency_ms", "n_results", "error"])
    res_f = open(f"{args.out_prefix}.results.jsonl", "w", encoding="utf-8")

    summary = {p: [] for p in providers}
    errors = {p: 0 for p in providers}

    for q in queries:
        for p in providers:
            # warmup（不计入统计）
            for _ in range(args.warmup):
                await run_one(p, q, args)
            saved = False
            for run in range(1, args.runs + 1):
                ms, results, err = await run_one(p, q, args)
                lat_w.writerow([p, q, run, f"{ms:.1f}" if ms else "", len(results), err or ""])
                if err: errors[p] += 1
                if ms is not None: summary[p].append(ms)
                # 每个 (provider,query) 只存第一条成功结果供人工评估
                if not saved and results:
                    res_f.write(json.dumps(
                        {"provider": p, "query": q, "results": results},
                        ensure_ascii=False) + "\n")
                    saved = True
            print(f"  [{p:9}] {q[:40]:<40} "
                  f"p50={pctl(summary[p][-args.runs:], 50) or 0:.0f}ms "
                  f"err={errors[p]}")
    lat_f.close(); res_f.close()

    print("\n===== 延迟汇总（ms，全部 query 合并）=====")
    print(f"{'provider':<10}{'n':>6}{'p50':>9}{'p95':>9}{'p99':>9}{'mean':>9}{'err':>6}")
    for p in providers:
        xs = summary[p]
        if xs:
            print(f"{p:<10}{len(xs):>6}{pctl(xs,50):>9.0f}{pctl(xs,95):>9.0f}"
                  f"{pctl(xs,99):>9.0f}{statistics.mean(xs):>9.0f}{errors[p]:>6}")
        else:
            print(f"{p:<10}{'0':>6}{'-':>9}{'-':>9}{'-':>9}{'-':>9}{errors[p]:>6}")
    print(f"\n输出: {args.out_prefix}.latency.csv  +  {args.out_prefix}.results.jsonl")
    print("效果评估：打开 results.jsonl，按 query 并排看三后端的 title/url/snippet 人工打分。")

if __name__ == "__main__":
    asyncio.run(main())
