#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
自动查找 + 自动核验引擎（无 API，基于公开网页抓取与网络搜索）。

查找范围（依据原始工作流步骤1拓展）：
  - 通用搜索（关键词 x 京津冀）
  - 招聘网站：BOSS直聘 / 猎聘 / 智联（site: 限定）
  - 垂直IT：IT168 / 至顶网（site: 限定）
  - 黄页/B2B：顺企网(11467) / 中国制造网（site: 限定）
  - 工商名录：企查查 / 天眼查公开页（site: 限定，仅搜索摘要）
  - 名单类：信创工委会成员名单；OEM/代工

核验（对应校验项，不含地址类）：
  a 存续/在业：抓取公司页面，检查是否可访问、有无注销/吊销/停业字样
  b 现用法定全称：名称是否含法定后缀
  d 双源交叉验证：搜索来源 + 官网页面（或两个独立域名来源）
  e 实体研产属性：页面/简介含生产/制造/研发/招聘等关键词

候选池维护：随机轮换查询、按天去重；超过 30 天的旧候选自动退出池（避免每天结果雷同）。

用法：python search.py [输出路径，默认 candidates.json]
环境变量：BING_API_KEY（可选，Azure Bing Web Search 免费档）；MAX_QUERIES（免 key 单次查询上限）
"""
import html as html_mod
import json
import os
import random
import re
import sys
import time
import urllib.parse
import urllib.request

REGIONS = ["北京", "天津", "河北"]
KEYWORDS = [
    "服务器 生产 厂家", "光端机 研发 厂家", "防火墙 制造 厂家",
    "工控机 组装 厂家", "网闸 生产 厂家", "OEM 服务器",
    "ODM 网络安全硬件", "信创整机 生产商", "工业交换机 生产 厂家",
    "串口服务器 生产 厂家", "加密机 生产 厂家", "单向网闸 厂商",
    "光纤网卡 生产", "国产化服务器 整机", "Bypass 网卡 厂商",
]
JOB_KWS = ["硬件研发工程师", "生产测试", "工艺工程师", "结构设计", "产线管理", "嵌入式开发"]

MAX_PER_QUERY = 12
MAX_TOTAL = 400
MAX_AGE_DAYS = 30
MAX_VERIFY_PER_RUN = 30
MAX_QUERIES_PER_RUN = int(os.environ.get("MAX_QUERIES", "24"))
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

COMPANY_SUFFIX = re.compile(
    r"(股份有限公司|有限责任公司|有限公司|股份公司|集团公司|集团|公司|工厂|制造厂|工场|厂)"
)
ENTITY_KW = re.compile(
    r"(生产|制造|组装|研发|研制|代工|产线|硬件|整机|设备|厂商|工厂|实业|招聘|工程师)"
)
DEAD_KW = re.compile(r"(注销|吊销|停业|清算|破产|已关闭|无法访问)")
ACTIVE_KW = re.compile(r"(成立于|成立时间|注册资金|注册资本|ICP|备案|版权所有|All Rights Reserved)")
BIZ_RULES = [
    ("服务器/信创整机", re.compile(r"(服务器|信创|整机|国产化|计算机|终端|工控机|存储|曙光|浪潮|华为|台式机|笔记本)")),
    ("数据中心", re.compile(r"(数据中心|IDC|云|智算|超算|机房|算力|CDN|带宽)")),
    ("网络安全", re.compile(r"(防火墙|网闸|安全|加密|VPN|入侵|检测|防护|网关|Bypass|单向|密码|保密|等保)")),
    ("工业通信", re.compile(r"(工业|交换机|串口|PLC|嵌入式|通信|光端机|光模块|光纤|以太网|无线|网关|物联)")),
]
JUNK_HOSTS = (
    "wikipedia.org", "baike.baidu.com", "zhihu.com", "sohu.com", "163.com",
    "sina.com", "qq.com", "bing.com", "baidu.com", "google.com", "gov.cn",
    "youtube.com", "douban.com", "map.baidu.com", "amap.com", "gaode.com",
    "baiducontent.com", "csdn.net", "toutiao.com",
)


def norm_name(s):
    s = str(s or "")
    s = re.sub(r"[\s\u3000\u200b\ufeff]+", "", s).upper()
    s = s.replace("（", "(").replace("）", ")")
    return s


def clean_title(title):
    t = html_mod.unescape(str(title or "")).strip()
    t = re.sub(r"[\s\-_|·—–]{1,3}(百度百科|知乎|招聘|官网|首页|联系方式|怎么样|排名|厂家直销).*$", "", t)
    t = re.sub(r"【[^】]*】", "", t)
    t = re.sub(r"[（(][^）)]*(官网|招聘|排名|百科)[^）)]*[）)]", "", t)
    t = re.sub(r"^[\s\-_|·—–]+|[\s\-_|·—–]+$", "", t)
    return t.strip()


def extract_company_name(raw_title):
    """从标题提取公司名：招聘页先截断；再按分隔符分段取含公司后缀的段；最后按区域锚点兜底。"""
    t = clean_title(raw_title)
    if not t:
        return ""
    m = re.search(r"(招聘|诚聘|急聘)", t)
    if m:
        t = t[: m.start()]
    segs = re.split(r"[-_|·—–,，:：;；]+", t)
    best = ""
    for i, seg in enumerate(segs):
        seg = seg.strip()
        if not looks_like_company(seg):
            continue
        if any(r in seg for r in REGIONS) or i == len(segs) - 1:
            best = seg
    if best:
        mm = COMPANY_SUFFIX.search(best)
        if mm:
            best = best[: mm.end()]
        return best.strip()
    for r in REGIONS:
        idx = t.rfind(r)
        if idx != -1:
            t = t[idx:]
            break
    mm = COMPANY_SUFFIX.search(t)
    if mm:
        t = t[: mm.end()]
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
    if "uddg=" in href:
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(href).query)
        if q.get("uddg"):
            return q["uddg"][0]
    return href


def is_junk(url, title):
    host = urllib.parse.urlsplit(url).netloc.lower() if url else ""
    return any(j in host for j in JUNK_HOSTS)


def in_region(title, snippet, url):
    blob = (title or "") + " " + (snippet or "") + " " + (url or "")
    return any(r in blob for r in REGIONS)


def ddg_search(query):
    url = "https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query})
    req = urllib.request.Request(
        url,
        headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9", "Accept": "text/html,application/xhtml+xml"},
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
    req = urllib.request.Request(url, headers={"Ocp-Apim-Subscription-Key": key, "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=25) as resp:
        data = json.loads(resp.read().decode("utf-8", "ignore"))
    items = []
    for it in (data.get("webPages") or {}).get("value", []):
        items.append((clean_title(it.get("name", "")), it.get("url", ""), it.get("snippet", "")))
    return items


def build_combos():
    combos = []
    for r in REGIONS:
        for kw in KEYWORDS:
            combos.append(("通用", r + " " + kw))
        for job in JOB_KWS:
            combos.append(("招聘-BOSS", "site:zhipin.com " + r + " " + job))
            combos.append(("招聘-猎聘", "site:liepin.com " + r + " " + job))
            combos.append(("招聘-智联", "site:zhaopin.com " + r + " " + job))
            combos.append(("招聘-通用", r + " " + job + " 招聘 公司"))
        for kw in KEYWORDS[:10]:
            combos.append(("垂直-IT168", "site:it168.com " + r + " " + kw))
            combos.append(("垂直-至顶网", "site:zhiding.cn " + r + " " + kw))
            combos.append(("黄页-顺企", "site:11467.com " + r + " " + kw))
            combos.append(("B2B-中国制造网", "site:made-in-china.com " + r + " " + kw))
            combos.append(("工商-企查查", "site:qichacha.com " + r + " " + kw))
            combos.append(("工商-天眼查", "site:tianyancha.com " + r + " " + kw))
        combos.append(("名单-信创", "信创工委会 成员名单 " + r))
        combos.append(("OEM", r + " 服务器 OEM 代工 厂商"))
    return combos


def rotate_queries():
    combos = build_combos()
    rng = random.Random(int(time.time() // 86400))
    n = min(MAX_QUERIES_PER_RUN, len(combos))
    return rng.sample(combos, n)


def fetch_page_text(url):
    """抓取网页正文文本（去除脚本/样式/标签），用于自动核验。"""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            raw = resp.read(250 * 1024).decode("utf-8", "ignore")
        raw = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", raw, flags=re.S | re.I)
        text = re.sub(r"<[^>]+>", " ", raw)
        text = html_mod.unescape(re.sub(r"\s+", " ", text))
        return text[:4000], True
    except Exception:  # noqa: BLE001
        return "", False


def verify_candidate(c):
    """爬取式自动核验：返回 {a,b,d,e} 判定（不含地址类）。"""
    name = c.get("name", "")
    snippet = c.get("scope_hint", "") or ""
    url = c.get("source_url", "") or ""
    verdict = {
        "b": {
            "pass": bool(re.search(r"(股份有限公司|有限责任公司|有限公司|集团)$", name)),
            "reason": "名称含法定全称后缀" if re.search(r"(股份有限公司|有限责任公司|有限公司|集团)$", name)
            else "名称疑似不完整，需核实现用法定全称",
        }
    }
    verdict["e"] = {
        "pass": bool(ENTITY_KW.search(name + " " + snippet)),
        "reason": "简介/经营范围含研产或招聘关键词" if ENTITY_KW.search(name + " " + snippet)
        else "未见实体研产关键词",
    }
    page_text, ok = fetch_page_text(url)
    if ok and page_text:
        if DEAD_KW.search(page_text):
            verdict["a"] = {"pass": False, "reason": "页面出现注销/吊销/停业等字样"}
        else:
            verdict["a"] = {"pass": True, "reason": "官网可访问，未见注销/吊销/停业字样"}
    else:
        verdict["a"] = {"pass": False, "reason": "无法访问公司页面，存续状态未能确认"}
    verdict["d"] = {
        "pass": ok and bool(ACTIVE_KW.search(page_text)),
        "reason": "搜索来源 + 官网页面双源佐证" if (ok and ACTIVE_KW.search(page_text))
        else "官网信息不足，双源佐证不充分",
    }
    verdict["checked_at"] = time.strftime("%Y-%m-%d %H:%M")
    return verdict


def load_existing(out_path):
    try:
        with open(out_path, encoding="utf-8") as f:
            data = json.load(f)
        return data.get("candidates", []) or []
    except (OSError, ValueError):
        return []


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else "candidates.json"
    bing_key = os.environ.get("BING_API_KEY", "").strip()
    today = time.strftime("%Y-%m-%d")
    today_ts = time.time()

    existing = load_existing(out_path)
    seen = set()
    kept = []
    for c in existing:
        first = c.get("first_seen", today)
        try:
            age = (today_ts - time.mktime(time.strptime(first, "%Y-%m-%d"))) / 86400
        except ValueError:
            age = 0
        if age > MAX_AGE_DAYS:
            continue  # 过期候选退出池，避免每天结果雷同
        key = norm_name(c.get("name"))
        if not key or key in seen:
            continue
        seen.add(key)
        kept.append(c)

    new_found = []
    queries = rotate_queries()
    if bing_key:
        queries = [("通用", r + " " + k) for r in REGIONS for k in KEYWORDS]
        print("使用 Bing API，共 %d 个查询" % len(queries), file=sys.stderr)

    for tag, query in queries:
        if len(new_found) >= MAX_TOTAL:
            break
        try:
            items = bing_api_search(query, bing_key) if bing_key else ddg_search(query)
        except Exception as exc:  # noqa: BLE001
            print("  [warn] %s 搜索失败: %s" % (query, exc), file=sys.stderr)
            time.sleep(1.5)
            continue
        kept_in_q = 0
        for title, url, snippet in items:
            if len(new_found) >= MAX_TOTAL:
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
            new_found.append({
                "name": name,
                "address_hint": "",
                "scope_hint": snippet[:180],
                "source_url": url,
                "bizline": classify_bizline(query, name + " " + snippet),
                "keyword": tag + " | " + query,
                "first_seen": today,
                "source_tag": tag,
            })
            kept_in_q += 1
        print("  [%s] %s -> %d 条结果，新增 %d 家" % (tag, query, len(items), kept_in_q), file=sys.stderr)
        time.sleep(2.2)

    # 自动核验：优先核验新候选，不足时补核验池内未核验的
    to_verify = [c for c in new_found if not c.get("verify")]
    for c in kept:
        if len(to_verify) >= MAX_VERIFY_PER_RUN:
            break
        if not c.get("verify"):
            to_verify.append(c)
    for c in to_verify[:MAX_VERIFY_PER_RUN]:
        try:
            c["verify"] = verify_candidate(c)
            print("  [verify] %s -> a:%s b:%s d:%s e:%s" % (
                c["name"],
                c["verify"]["a"]["pass"], c["verify"]["b"]["pass"],
                c["verify"]["d"]["pass"], c["verify"]["e"]["pass"],
            ), file=sys.stderr)
        except Exception as exc:  # noqa: BLE001
            print("  [warn] 核验失败 %s: %s" % (c["name"], exc), file=sys.stderr)
        time.sleep(0.8)

    merged = kept + new_found
    merged = merged[:MAX_TOTAL]
    payload = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": "bing_api" if bing_key else "duckduckgo",
        "count": len(merged),
        "new_count": len(new_found),
        "candidates": merged,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    js_path = os.path.splitext(out_path)[0] + ".js"
    with open(js_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("window.GRT_CANDIDATES = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print("结果池现有 %d 家候选（本次新增 %d 家，核验 %d 家）-> %s" % (
        len(merged), len(new_found), len(to_verify[:MAX_VERIFY_PER_RUN]), out_path))
    print("已同步输出候选JS（本地版读取用）-> %s" % js_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
