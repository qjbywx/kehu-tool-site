#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
自动查找引擎：搜索真实企业候选，累积输出 candidates.json。

搜索源：
  1) 若设置环境变量 BING_API_KEY（Azure Bing Web Search，免费档每月 1000 次），优先使用 API；
  2) 否则回退 DuckDuckGo HTML 端点（免 key，单次运行查询量受限）。

流程：关键词 x 京津冀区域（按天轮换子集）-> 搜索 -> 提取公司名 -> 区域/实体关键词筛选 ->
      业务线自动分类 -> 与历史池合并去重 -> 输出 candidates.json（供网页工具一键拉取）。

用法：python search.py [输出路径，默认 candidates.json]
"""
import html as html_mod
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

REGIONS = ["北京", "天津", "河北"]
KEYWORDS = [
    "服务器 生产 厂家",
    "光端机 研发 厂家",
    "防火墙 制造 厂家",
    "工控机 组装 厂家",
    "网闸 生产 厂家",
    "OEM 服务器",
    "ODM 网络安全硬件",
    "信创整机 生产商",
    "工业交换机 生产 厂家",
    "串口服务器 生产 厂家",
    "加密机 生产 厂家",
    "单向网闸 厂商",
    "光纤网卡 生产",
    "国产化服务器 整机",
]

MAX_PER_QUERY = 12
MAX_TOTAL = 400          # 结果池上限（跨批次累积）
MAX_QUERIES_PER_RUN = 14  # 免 key 模式下单次运行查询上限（DDG 易限流）
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

COMPANY_SUFFIX = re.compile(
    r"(股份有限公司|有限责任公司|有限公司|股份公司|集团公司|集团|公司|工厂|制造厂|工场|厂)"
)
# 明显不是公司页的域名
JUNK_HOSTS = (
    "wikipedia.org", "baike.baidu.com", "zhihu.com", "sohu.com", "163.com",
    "sina.com", "qq.com", "bing.com", "baidu.com", "google.com", "gov.cn",
    "youtube.com", "douban.com", "map.baidu.com", "amap.com", "gaode.com",
    "tianyancha.com", "qcc.com", "aiqicha.com", "baiducontent.com",
)
# 实体属性关键词（硬件研发/生产/制造/代工）
ENTITY_KW = re.compile(
    r"(生产|制造|组装|研发|研制|代工|产线|硬件|整机|设备|厂商|工厂|实业)"
)
# 业务线关键词
BIZ_RULES = [
    ("服务器/信创整机", re.compile(r"(服务器|信创|整机|国产化|计算机|终端|工控机|存储|曙光|浪潮|华为|台式机|笔记本)")),
    ("数据中心", re.compile(r"(数据中心|IDC|云|智算|超算|机房|算力|CDN|带宽)")),
    ("网络安全", re.compile(r"(防火墙|网闸|安全|加密|VPN|入侵|检测|防护|网关|Bypass|单向|密码|保密|等保)")),
    ("工业通信", re.compile(r"(工业|交换机|串口|PLC|嵌入式|通信|光端机|光模块|光纤|以太网|无线|网关|物联)")),
]


def norm_name(s):
    s = str(s or "")
    s = re.sub(r"[\s\u3000\u200b\ufeff]+", "", s).upper()
    s = s.replace("（", "(").replace("）", ")")
    return s


def clean_title(title):
    t = html_mod.unescape(str(title or "")).strip()
    # 去掉常见装饰后缀
    t = re.sub(r"[\s\-_|·—–]{1,3}(百度百科|知乎|招聘|官网|首页|联系方式|怎么样|排名|厂家直销).*$", "", t)
    t = re.sub(r"【[^】]*】", "", t)
    t = re.sub(r"[（(][^）)]*(官网|招聘|排名|百科)[^）)]*[）)]", "", t)
    t = re.sub(r"^[\s\-_|·—–]+|[\s\-_|·—–]+$", "", t)
    return t.strip()


def extract_company_name(raw_title):
    """从搜索引擎标题中提取公司名。
    策略：按常见分隔符分段，取“含公司后缀且含区域词（或为最后一段）”的段；
    无命中时回退到以最后一个京津冀区域词为锚点截取。"""
    t = clean_title(raw_title)
    if not t:
        return ""
    segs = re.split(r"[-_|·—–,，:：;；]+", t)
    best = ""
    for i, seg in enumerate(segs):
        seg = seg.strip()
        if not looks_like_company(seg):
            continue
        if any(r in seg for r in REGIONS) or i == len(segs) - 1:
            best = seg
    if best:
        m = COMPANY_SUFFIX.search(best)
        if m:
            best = best[: m.end()]
        return best.strip()
    for r in REGIONS:
        idx = t.rfind(r)
        if idx != -1:
            t = t[idx:]
            break
    m = COMPANY_SUFFIX.search(t)
    if m:
        t = t[: m.end()]
    t = re.sub(r"[（(][^）)]*[）)]$", "", t)  # 去掉尾部的（分公司）之类
    t = re.sub(r"[\s\-_|·—–:：,，.。、]+$", "", t)
    return t.strip()


def looks_like_company(name):
    if not name or len(name) < 6:
        return False
    if not COMPANY_SUFFIX.search(name):
        return False
    return True


def classify_bizline(query, text):
    blob = query + " " + text
    best = ""
    best_len = -1
    for label, pat in BIZ_RULES:
        m = pat.search(blob)
        if m and len(m.group(0)) > best_len:
            best = label
            best_len = len(m.group(0))
    return best


def extract_url(href):
    # DDG 格式：//duckduckgo.com/l/?uddg=<encoded>&rut=...
    if "uddg=" in href:
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(href).query)
        if q.get("uddg"):
            return q["uddg"][0]
    return href


def is_junk(url, title):
    host = urllib.parse.urlsplit(url).netloc.lower() if url else ""
    if any(j in host for j in JUNK_HOSTS):
        return True
    return False


def in_region(title, snippet, url):
    blob = (title or "") + " " + (snippet or "") + " " + (url or "")
    return any(r in blob for r in REGIONS)


def ddg_search(query):
    url = "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query})
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        page = resp.read().decode("utf-8", "ignore")

    items = []
    anchors = re.findall(r'<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', page, re.S)
    snippets = re.findall(r'<a[^>]*class="result__snippet"[^>]*>(.*?)</a>', page, re.S)
    for i, (href, title_html) in enumerate(anchors):
        title = clean_title(re.sub(r"<[^>]+>", "", title_html))
        snippet = html_mod.unescape(re.sub(r"<[^>]+>", "", snippets[i])) if i < len(snippets) else ""
        items.append((title, extract_url(href), snippet))
    return items


def bing_api_search(query, key):
    url = "https://api.bing.microsoft.com/v7.0/search?" + urllib.parse.urlencode(
        {"q": query, "count": MAX_PER_QUERY, "mkt": "zh-CN", "setLang": "zh-hans"}
    )
    req = urllib.request.Request(
        url,
        headers={"Ocp-Apim-Subscription-Key": key, "User-Agent": UA},
    )
    with urllib.request.urlopen(req, timeout=25) as resp:
        data = json.loads(resp.read().decode("utf-8", "ignore"))
    items = []
    for it in (data.get("webPages") or {}).get("value", []):
        items.append((clean_title(it.get("name", "")), it.get("url", ""), it.get("snippet", "")))
    return items


def load_existing(out_path):
    try:
        with open(out_path, encoding="utf-8") as f:
            data = json.load(f)
        return data.get("candidates", []) or []
    except (OSError, ValueError):
        return []


def rotate_queries(day_offset=0):
    """按天轮换关键词 x 区域子集，避免单次运行查询过多触发限流。"""
    combos = [r + " " + k for r in REGIONS for k in KEYWORDS]
    start = (day_offset * MAX_QUERIES_PER_RUN) % len(combos)
    chosen = []
    for i in range(MAX_QUERIES_PER_RUN):
        chosen.append(combos[(start + i) % len(combos)])
    return chosen


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "candidates.json"
    bing_key = os.environ.get("BING_API_KEY", "").strip()
    seen = set()
    results = []

    existing = load_existing(out_path)
    for c in existing:
        key = norm_name(c.get("name"))
        if key:
            seen.add(key)

    queries = rotate_queries(day_offset=int(time.time() // 86400))
    if bing_key:
        queries = [r + " " + k for r in REGIONS for k in KEYWORDS]
        print("使用 Bing API，共 %d 个查询" % len(queries), file=sys.stderr)

    for query in queries:
        if len(results) >= MAX_TOTAL:
            break
        try:
            if bing_key:
                items = bing_api_search(query, bing_key)
            else:
                items = ddg_search(query)
        except Exception as exc:  # noqa: BLE001
            print("  [warn] %s 搜索失败: %s" % (query, exc), file=sys.stderr)
            time.sleep(2)
            continue

        kept = 0
        for title, url, snippet in items:
            if len(results) >= MAX_TOTAL:
                break
            name = extract_company_name(title)
            if not looks_like_company(name):
                continue
            if is_junk(url, name):
                continue
            if not in_region(name, snippet, url):
                continue
            if not ENTITY_KW.search(name + " " + snippet):
                continue
            key = norm_name(name)
            if not key or key in seen:
                continue
            seen.add(key)
            results.append({
                "name": name,
                "address_hint": "",
                "scope_hint": snippet[:180],
                "source_url": url,
                "bizline": classify_bizline(query, name + " " + snippet),
                "keyword": query,
            })
            kept += 1
        print("  %s -> %d 条结果，新增 %d 家" % (query, len(items), kept), file=sys.stderr)
        time.sleep(2.5)

    merged = existing + results
    merged = merged[:MAX_TOTAL]

    payload = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": "bing_api" if bing_key else "duckduckgo",
        "count": len(merged),
        "new_count": len(results),
        "candidates": merged,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print("结果池现有 %d 家候选（本次新增 %d 家）-> %s" % (len(merged), len(results), out_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
