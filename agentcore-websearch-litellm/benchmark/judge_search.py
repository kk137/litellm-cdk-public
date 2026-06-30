#!/usr/bin/env python3
"""
LLM-as-judge 搜索结果效果评估（盲评）—— 在 LiteLLM Pod 内运行。

读 benchmark 产出的 results.jsonl，对每个 query：
  1. 取四后端 top-N 结果
  2. 匿名化成 A/B/C/D + 确定性打乱（盲评：judge 看不到 provider 名）
  3. 喂 GPT-5.5（/v1/responses）按 4 维度打分
  4. 事后映射回真实 provider，聚合

维度（各 1-5 分）：relevance 相关性 / freshness 时效性 / source_quality 来源质量 / noise 噪声(越少越好,5=无噪声)

用法（Pod 内）：
  MK=<master key>
  python3 judge_search.py --results bench.results.jsonl,sx.results.jsonl \
    --judge-model gpt-5.5 --master-key $MK --topn 5 --out-prefix eval

输出: eval.scores.csv（provider×query×维度）+ eval.judge.jsonl（含理由原文）
"""
import argparse, csv, hashlib, json, statistics, sys, time, urllib.request

ORDER = ["exa_ai", "tavily", "searxng", "agentcore"]
DIMS = ["relevance", "freshness", "source_quality", "noise"]

def load(files):
    data = {}
    for fn in files:
        for line in open(fn, encoding="utf-8"):
            d = json.loads(line)
            data.setdefault(d["query"], {})[d["provider"]] = d["results"]
    return data

def shuffle_det(provs_present, query):
    """确定性打乱：用 query hash 决定顺序，可复现且每 query 不同。"""
    h = int(hashlib.sha256(query.encode()).hexdigest(), 16)
    lst = list(provs_present)
    # Fisher-Yates，随机源用 hash 派生
    for i in range(len(lst) - 1, 0, -1):
        h = (h * 1103515245 + 12345) & 0x7FFFFFFF
        j = h % (i + 1)
        lst[i], lst[j] = lst[j], lst[i]
    return lst

def call_judge(model, mk, prompt):
    body = json.dumps({"model": model, "input": prompt}).encode()
    req = urllib.request.Request(
        "http://localhost:4000/v1/responses", data=body,
        headers={"Authorization": "Bearer " + mk, "Content-Type": "application/json"})
    r = urllib.request.urlopen(req, timeout=120)
    d = json.loads(r.read())
    txt = ""
    for o in d.get("output", []):
        for c in o.get("content", []):
            txt += c.get("text", "")
    return txt

PROMPT_TMPL = """你是搜索质量评审。下面是针对同一个查询，由多个匿名搜索引擎（标记为 A/B/C/D）各自返回的 top 结果。
请**只根据结果内容本身**客观打分，不要猜测是哪个引擎。

查询: {query}

{candidates}

请对每个候选(A/B/C/D)按以下 4 个维度各打 1-5 分（5 最好）：
- relevance: 结果是否直接、准确地回答该查询
- freshness: 对含"最新/2026/latest"类查询，是否命中最新信息（非时效类查询给中性分3-4）
- source_quality: 来源是否权威可信（官方文档/知名站 高分；内容农场/无关站 低分）
- noise: 是否**没有**混入无关/跑题结果（5=完全无噪声, 1=大量噪声）

只输出 JSON，格式：
{{"A":{{"relevance":N,"freshness":N,"source_quality":N,"noise":N,"reason":"一句话"}}, "B":{{...}}, "C":{{...}}, "D":{{...}}}}
不要输出 JSON 以外的任何文字。"""

def fmt_candidates(letter_to_prov, provs, topn):
    blocks = []
    for letter, prov in letter_to_prov.items():
        items = provs.get(prov, [])[:topn]
        lines = [f"候选 {letter}:"]
        for i, r in enumerate(items, 1):
            lines.append(f"  {i}. {r.get('title','')[:90]}")
            lines.append(f"     {r.get('url','')[:70]}")
            sn = (r.get('snippet','') or '')[:140].replace('\n', ' ')
            lines.append(f"     {sn}")
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)

def extract_json(txt):
    s = txt.find("{"); e = txt.rfind("}")
    if s == -1 or e == -1: raise ValueError("no json in: " + txt[:200])
    return json.loads(txt[s:e+1])

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True, help="逗号分隔的 jsonl")
    ap.add_argument("--judge-model", default="gpt-5.5")
    ap.add_argument("--master-key", required=True)
    ap.add_argument("--topn", type=int, default=5)
    ap.add_argument("--out-prefix", default="eval")
    args = ap.parse_args()

    data = load([f.strip() for f in args.results.split(",")])
    print(f"queries={len(data)}  judge={args.judge_model}  topn={args.topn}\n")

    sc_f = open(f"{args.out_prefix}.scores.csv", "w", newline="", encoding="utf-8")
    sc_w = csv.writer(sc_f); sc_w.writerow(["query", "provider"] + DIMS + ["avg"])
    jl_f = open(f"{args.out_prefix}.judge.jsonl", "w", encoding="utf-8")

    agg = {p: {d: [] for d in DIMS} for p in ORDER}
    for qi, (q, provs) in enumerate(data.items(), 1):
        present = [p for p in ORDER if provs.get(p)]
        shuffled = shuffle_det(present, q)
        letters = "ABCD"
        l2p = {letters[i]: shuffled[i] for i in range(len(shuffled))}  # A/B/C/D -> provider
        prompt = PROMPT_TMPL.format(query=q, candidates=fmt_candidates(l2p, provs, args.topn))
        try:
            raw = call_judge(args.judge_model, args.master_key, prompt)
            scores = extract_json(raw)
        except Exception as e:
            print(f"  Q{qi} judge 失败: {type(e).__name__}: {str(e)[:80]}")
            continue
        # 映射回 provider
        line_out = {"query": q, "mapping": l2p, "scores_by_letter": scores}
        jl_f.write(json.dumps(line_out, ensure_ascii=False) + "\n")
        row_summary = []
        for letter, prov in l2p.items():
            s = scores.get(letter, {})
            vals = [s.get(d) for d in DIMS if isinstance(s.get(d), (int, float))]
            avg = statistics.mean(vals) if vals else 0
            sc_w.writerow([q, prov] + [s.get(d, "") for d in DIMS] + [f"{avg:.2f}"])
            for d in DIMS:
                if isinstance(s.get(d), (int, float)): agg[prov][d].append(s[d])
            row_summary.append(f"{prov}={avg:.1f}")
        print(f"  Q{qi} {q[:34]:<34} " + "  ".join(row_summary))
    sc_f.close(); jl_f.close()

    print("\n===== 效果汇总（各维度均分，1-5）=====")
    print(f"{'provider':<10}" + "".join(f"{d:>15}" for d in DIMS) + f"{'总均':>8}")
    for p in ORDER:
        cells = []
        allv = []
        for d in DIMS:
            xs = agg[p][d]
            cells.append(f"{statistics.mean(xs):>15.2f}" if xs else f"{'-':>15}")
            allv += xs
        tot = f"{statistics.mean(allv):>8.2f}" if allv else f"{'-':>8}"
        print(f"{p:<10}" + "".join(cells) + tot)
    print(f"\n输出: {args.out_prefix}.scores.csv  +  {args.out_prefix}.judge.jsonl")

if __name__ == "__main__":
    main()
