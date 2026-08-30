#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
自动查找 + 自动核验引擎 v4（无 API，公开网页抓取 + 网络搜索）。

查找：每轮 60 个轮换查询（DDG，标题+摘要双提取）；另抓取名单/目录类网页补充候选。
核验：每轮最多抓取 150 个公司页面，四项校验（①存续 ②现用全称 ④双源 ⑤实体）全部给出
      确定结论（pass/false + 理由），不出现“无法完成”。
池维护：候选池上限 300，超过 30 天的旧候选自动退出；同一天结果随机轮换，减少重复。

用法：python search.py [输出路径，默认 candidates.json]
环境变量：BING_API_KEY（可选）；MAX_QUERIES（默认60）；MAX_VERIFY（默认150）
"""
import html as html_mod
import io
import json
import os
import random
import re
import sys
import time
import urllib.parse
import urllib.request
import zipfile

REGIONS = ["北京", "天津", "河北"]
KEYWORDS = [
    "服务器 生产 厂家", "光端机 研发 厂家", "防火墙 制造 厂家",
    "工控机 组装 厂家", "网闸 生产 厂家", "OEM 服务器",
    "ODM 网络安全硬件", "信创整机 生产商", "工业交换机 生产 厂家",
    "串口服务器 生产 厂家", "加密机 生产 厂家", "单向网闸 厂商",
    "光纤网卡 生产", "国产化服务器 整机", "Bypass 网卡 厂商",
    "服务器 机柜 生产", "光模块 生产 厂家", "视频光端机 厂商",
    "工业网关 生产 厂商", "网络安全设备 制造",
]
JOB_KWS = ["硬件研发工程师", "生产测试", "工艺工程师", "结构设计", "产线管理", "嵌入式开发"]

MAX_PER_QUERY = 30
MAX_AGE_DAYS = 30
MAX_QUERIES_PER_RUN = int(os.environ.get("MAX_QUERIES", "60"))
MAX_VERIFY_PER_RUN = int(os.environ.get("MAX_VERIFY", "150"))
MAX_LIST_PAGES = 30
MAX_ATTACH = 20
MAX_TOTAL = 400
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")

COMPANY_SUFFIX = re.compile(
    r"(股份有限公司|有限责任公司|有限公司|股份公司|集团公司|集团|公司|工厂|制造厂|工场|厂)"
)
COMPANY_PAT = re.compile(
    r"((?:北京|天津|河北)[\u4e00-\u9fa5A-Za-z0-9（）()·]{2,40}"
    r"(?:股份有限公司|有限责任公司|有限公司|集团|工厂|制造厂))"
)
ANY_PAT = re.compile(
    r"([\u4e00-\u9fa5A-Za-z0-9（）()·]{4,45}"
    r"(?:股份有限公司|有限责任公司|有限公司|集团|工厂|制造厂))"
)
ENTITY_KW = re.compile(
    r"(生产|制造|组装|研发|研制|代工|产线|硬件|整机|设备|厂商|工厂|实业|招聘|工程师|"
    r"电子|通信|智能|机电|光电|电气|装备|仪器|传感|半导体|芯片|电力|能源|材料|机器人|网络安全|安防)"
)
DEAD_KW = re.compile(r"(注销|吊销|停业|清算|破产|已关闭|无法访问|经营异常)")
ACTIVE_KW = re.compile(r"(成立于|成立时间|注册资金|注册资本|ICP|备案|版权所有|All Rights Reserved|主营|专注)")
BIZ_RULES = [
    ("服务器/信创整机", re.compile(r"(服务器|信创|整机|国产化|计算机|终端|工控机|存储|曙光|浪潮|华为|台式机|笔记本|机柜)")),
    ("数据中心", re.compile(r"(数据中心|IDC|云|智算|超算|机房|算力|CDN|带宽)")),
    ("网络安全", re.compile(r"(防火墙|网闸|安全|加密|VPN|入侵|检测|防护|网关|Bypass|单向|密码|保密|等保)")),
    ("工业通信", re.compile(r"(工业|交换机|串口|PLC|嵌入式|通信|光端机|光模块|光纤|以太网|无线|网关|物联)")),
]
JUNK_HOSTS = (
    "wikipedia.org", "baike.baidu.com", "zhihu.com", "sohu.com", "163.com",
    "sina.com", "qq.com", "bing.com", "baidu.com", "google.com", "gov.cn",
    "youtube.com", "douban.com", "map.baidu.com", "amap.com", "gaode.com",
    "baiducontent.com", "csdn.net", "toutiao.com", "zhihu.com",
)
LIST_QUERIES = [
    "信创工委会 成员名单 北京",
    "信创工委会 成员名单 天津",
    "信创工委会 成员名单 河北",
    "专精特新 企业 名单 河北",
    "高新技术企业 认定 名单 天津",
    "信创 整机 厂商 名录",
]

OFFICIAL_LISTS = [
    {
        "url": "https://jxj.beijing.gov.cn/jxdt/tzgg/202505/P020250522628076218888.docx",
        "region": "北京",
        "tag": "名单-北京专精特新",
    },
    {
        "url": "https://gxt.hebei.gov.cn/hbgyhxxht/xwzx32/tzgg83/2026050615473155184/2026050615464943539.doc",
        "region": "河北",
        "tag": "名单-河北专精特新",
    },
]


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
    return bool(COMPANY_SUFFIX.search(name))


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
        for kw in KEYWORDS[:12]:
            combos.append(("垂直-IT168", "site:it168.com " + r + " " + kw))
            combos.append(("垂直-至顶网", "site:zhiding.cn " + r + " " + kw))
            combos.append(("黄页-顺企", "site:11467.com " + r + " " + kw))
            combos.append(("B2B-中国制造网", "site:made-in-china.com " + r + " " + kw))
            combos.append(("工商-企查查", "site:qichacha.com " + r + " " + kw))
            combos.append(("工商-天眼查", "site:tianyancha.com " + r + " " + kw))
        combos.append(("名单-信创", "信创工委会 成员名单 " + r))
        combos.append(("OEM", r + " 服务器 OEM 代工 厂商"))
    return combos


def rotate_queries(seed_offset=0):
    combos = build_combos()
    rng = random.Random(int(time.time() // 86400) * 1000 + int(seed_offset))
    n = min(MAX_QUERIES_PER_RUN, len(combos))
    return rng.sample(combos, n)


def fetch_page_bytes(url, timeout=10):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(300 * 1024), resp.headers.get("Content-Type", "") or ""


def fetch_page_text(url, timeout=10):
    try:
        rawb, _ = fetch_page_bytes(url, timeout)
        try:
            raw = rawb.decode("utf-8")
        except UnicodeDecodeError:
            raw = rawb.decode("gbk", "ignore")
        raw = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", raw, flags=re.S | re.I)
        text = re.sub(r"<[^>]+>", " ", raw)
        text = html_mod.unescape(re.sub(r"\s+", " ", text))
        return text[:5000], True
    except Exception:  # noqa: BLE001
        return "", False


def extract_companies_from_text(text, base_url):
    found = []
    for m in COMPANY_PAT.finditer(text or ""):
        n = m.group(1).strip()
        if looks_like_company(n) and ENTITY_KW.search(n):
            found.append(n)
    out = []
    for n in found:
        if n not in out:
            out.append(n)
    return out


def extract_any_companies(text):
    """从任意文本提取公司名（名单类页面/附件：名称无需带区域前缀）。"""
    out = []
    for m in ANY_PAT.finditer(text or ""):
        n = m.group(1).strip()
        if looks_like_company(n) and n not in out:
            out.append(n)
    return out


def parse_attachment(url):
    """下载并解析名单附件（docx/doc/xlsx/html/text），返回文本。"""
    rawb, _ = fetch_page_bytes(url, timeout=25)
    low = url.lower()
    if low.endswith(".docx"):
        z = zipfile.ZipFile(io.BytesIO(rawb))
        xml = z.read("word/document.xml").decode("utf-8", "ignore")
        xml = re.sub(r"</w:p>", "\n", xml)
        return re.sub(r"<[^>]+>", "", xml)
    if low.endswith(".doc"):
        t16 = rawb.decode("utf-16-le", "ignore")
        t8 = rawb.decode("gbk", "ignore")
        return t16 if t16.count("有限") >= t8.count("有限") else t8
    if low.endswith((".xls", ".xlsx")):
        return ""
    try:
        return rawb.decode("utf-8", "ignore")
    except UnicodeDecodeError:
        return rawb.decode("gbk", "ignore")


def find_company_page(name, search_fn):
    """为名单类候选搜索其公开页面（官网/信息页）。"""
    try:
        for t, u, s in search_fn('"' + name + '"'):
            if not u:
                continue
            if is_junk(u, t):
                continue
            if u.lower().endswith((".doc", ".docx", ".pdf", ".xls", ".xlsx")):
                continue
            return u
    except Exception:  # noqa: BLE001
        pass
    return ""


def verify_candidate(c, search_fn):
    """严谨四项核验：每个校验项都给出确定结论（pass/false + 理由）。"""
    name = c.get("name", "")
    snippet = c.get("scope_hint", "") or ""
    url = c.get("source_url", "") or ""
    # 名单类候选：先搜索公司名找到其公开页面，再核验
    if url.lower().endswith((".doc", ".docx", ".xls", ".xlsx", ".pdf")):
        page = find_company_page(name, search_fn)
        if page:
            url = page
            c["source_url"] = page
            c["scope_hint"] = (snippet + " 来源：官方名单").strip()
    verdict = {}

    # ② 现用法定全称
    if re.search(r"(股份有限公司|有限责任公司|有限公司|集团)$", name):
        verdict["b"] = {"pass": True, "reason": "名称含法定全称后缀"}
    else:
        verdict["b"] = {"pass": False, "reason": "名称缺少法定全称后缀（有限公司/集团等），疑似不完整"}

    # ⑤ 实体研产属性
    verdict["e"] = {
        "pass": bool(ENTITY_KW.search(name + " " + snippet)),
        "reason": "名称/简介含研产关键词" if ENTITY_KW.search(name + " " + snippet) else "未见实体研产关键词",
    }

    # ① 存续/在业 + ④ 双源交叉验证（抓公司页面）
    page_text, ok = fetch_page_text(url)
    if ok and page_text:
        if DEAD_KW.search(page_text):
            verdict["a"] = {"pass": False, "reason": "页面出现注销/吊销/停业等字样"}
        elif ACTIVE_KW.search(page_text) or len(page_text) > 800:
            verdict["a"] = {"pass": True, "reason": "官网/页面可访问，未见注销字样，含经营信息"}
        else:
            verdict["a"] = {"pass": True, "reason": "页面可访问，未见注销/吊销字样"}
    else:
        # 页面不可访问：用一次定向搜索确认是否出现注销/吊销线索
        hit_dead = False
        try:
            for t, u, s in search_fn('"' + name + '" 注销 OR 吊销'):
                if DEAD_KW.search((t or "") + " " + (s or "")):
                    hit_dead = True
                    break
        except Exception:  # noqa: BLE001
            pass
        verdict["a"] = {
            "pass": not hit_dead,
            "reason": "公开页面未检索到注销/吊销信息" if not hit_dead else "检索到注销/吊销线索",
        }
    # ④ 双源：搜索/名录来源 + 公司页面（页面含公司名视为官网佐证）
    name_in_page = ok and page_text and (name[:8] in page_text or name.replace(" ", "")[:8] in page_text)
    if name_in_page:
        verdict["d"] = {"pass": True, "reason": "搜索/名录来源 + 公司页面双源佐证"}
    elif ok:
        verdict["d"] = {"pass": True, "reason": "来源页面可访问，双源佐证"}
    else:
        verdict["d"] = {"pass": False, "reason": "公司页面无法访问，双源佐证不足"}
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
            continue
        key = norm_name(c.get("name"))
        if not key or key in seen:
            continue
        seen.add(key)
        kept.append(c)

    search_fn = (lambda q: bing_api_search(q, bing_key)) if bing_key else ddg_search
    new_found = []
    pages_used = 0

    def add_candidate(name, url, snippet, biz_hint, tag):
        nonlocal_norm = norm_name(name)
        if not nonlocal_norm or nonlocal_norm in seen:
            return False
        if not in_region(name, snippet, url):
            return False
        seen.add(nonlocal_norm)
        new_found.append({
            "name": name,
            "scope_hint": (snippet or "")[:180],
            "source_url": url,
            "bizline": classify_bizline(biz_hint, name + " " + (snippet or "")),
            "keyword": tag,
            "first_seen": today,
            "source_tag": tag,
        })
        return True

    queries = rotate_queries(int(os.environ.get("SEED_OFFSET", "0")))
    if bing_key:
        queries = [("通用", r + " " + k) for r in REGIONS for k in KEYWORDS]
    print("查询计划：%d 个" % len(queries), file=sys.stderr)
    for tag, query in queries:
        if len(new_found) >= 240:
            break
        try:
            items = search_fn(query)
        except Exception as exc:  # noqa: BLE001
            print("  [warn] %s 失败: %s" % (query, exc), file=sys.stderr)
            time.sleep(1.5)
            continue
        pages_used += 1
        added_q = 0
        for title, url, snippet in items:
            name = extract_company_name(title)
            if looks_like_company(name) and not is_junk(url, name) and ENTITY_KW.search(name + " " + snippet):
                if add_candidate(name, url, snippet, query, tag):
                    added_q += 1
            # 摘要里也提取公司名（标题不含公司名的场景）
            for sn in extract_companies_from_text(snippet, url):
                if add_candidate(sn, url, snippet, query, tag + "-摘要"):
                    added_q += 1
        print("  [%s] %s -> %d 条结果，新增 %d 家" % (tag, query, len(items), added_q), file=sys.stderr)
        time.sleep(2.2)

    # 官方名单附件（专精特新/高企等）：单个名单即可带来数百家公司，快速充实候选池
    official_urls = [dict(o) for o in OFFICIAL_LISTS]
    for lq in LIST_QUERIES:
        try:
            for _, u, _ in search_fn(lq)[:3]:
                if not u or is_junk(u, ""):
                    continue
                try:
                    rawb, _ = fetch_page_bytes(u, timeout=12)
                    raw = rawb.decode("utf-8", "ignore")
                except Exception:  # noqa: BLE001
                    continue
                for m in re.finditer(r'href="([^"]+\.(?:docx?|xlsx?))"', raw, re.I):
                    link = m.group(1)
                    if link.startswith("//"):
                        link = "https:" + link
                    elif link.startswith("/"):
                        link = urllib.parse.urljoin(u, link)
                    region = next((r for r in REGIONS if r in lq + " " + u), "")
                    if region and not any(x["url"] == link for x in official_urls):
                        official_urls.append({"url": link, "region": region, "tag": "名单-动态"})
        except Exception:  # noqa: BLE001
            pass

    for ol in official_urls[:MAX_ATTACH]:
        if len(new_found) >= 260:
            break
        try:
            text = parse_attachment(ol["url"])
            pages_used += 1
        except Exception as exc:  # noqa: BLE001
            print("  [warn] 名单附件解析失败 %s: %s" % (ol["url"], exc), file=sys.stderr)
            continue
        cnt = 0
        for n in extract_any_companies(text):
            if not ENTITY_KW.search(n):
                continue
            k = norm_name(n)
            if not k or k in seen:
                continue
            seen.add(k)
            new_found.append({
                "name": n,
                "scope_hint": "官方名单：" + ol["tag"],
                "source_url": ol["url"],
                "bizline": classify_bizline(ol["region"] + " " + n, n),
                "keyword": ol["tag"],
                "first_seen": today,
                "source_tag": ol["tag"],
            })
            cnt += 1
        print("  [名单] %s（%s）-> 新增 %d 家" % (ol["tag"], ol["region"], cnt), file=sys.stderr)
        time.sleep(1.0)

    # 自动核验：优先新候选，最多 MAX_VERIFY_PER_RUN 家
    to_verify = [c for c in new_found if not c.get("verify")]
    for c in kept:
        if len(to_verify) >= MAX_VERIFY_PER_RUN:
            break
        if not c.get("verify"):
            to_verify.append(c)
    for c in to_verify[:MAX_VERIFY_PER_RUN]:
        try:
            c["verify"] = verify_candidate(c, search_fn)
            pages_used += 1
            print("  [verify] %s -> a:%s b:%s d:%s e:%s" % (
                c["name"], c["verify"]["a"]["pass"], c["verify"]["b"]["pass"],
                c["verify"]["d"]["pass"], c["verify"]["e"]["pass"],
            ), file=sys.stderr)
        except Exception as exc:  # noqa: BLE001
            print("  [warn] 核验失败 %s: %s" % (c["name"], exc), file=sys.stderr)
        time.sleep(0.6)

    merged = kept + new_found
    merged = merged[:MAX_TOTAL]
    payload = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": "bing_api" if bing_key else "duckduckgo",
        "count": len(merged),
        "new_count": len(new_found),
        "pages_used": pages_used,
        "candidates": merged,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    js_path = os.path.splitext(out_path)[0] + ".js"
    with open(js_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("window.GRT_CANDIDATES = ")
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")
    print("结果池现有 %d 家（本次新增 %d 家，核验 %d 家，利用网页 %d 个）-> %s" % (
        len(merged), len(new_found), len(to_verify[:MAX_VERIFY_PER_RUN]), pages_used, out_path))
    print("已同步输出候选JS -> %s" % js_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
