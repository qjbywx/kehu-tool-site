# -*- coding: utf-8 -*-
"""
把《查找汇总表格.xlsx》中的公司名称导出为去重库A JSON 文件（dedup_a.json）。
网页工具首次使用时上传该文件即可，客户名单不会进入任何仓库。
用法：
    python build_dedup.py [xlsx路径] [输出路径]
不传参数时默认读取 F:/桌面/查找汇总表格.xlsx，输出到 dedup_a.json
"""
import io
import json
import os
import re
import sys

try:
    import openpyxl
except ImportError:
    sys.exit("缺少 openpyxl，请先安装：pip install openpyxl")

APP_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "app.js")
DEFAULT_XLSX = r"F:/桌面/查找汇总表格.xlsx"


def norm(name):
    s = str(name or "").strip()
    # 与 app.js 中的 GRT.norm 保持一致：去空格、转大写、括号统一为英文半角
    s = re.sub(r"[\s\u3000\u200b\ufeff]+", "", s).upper()
    s = s.replace("（", "(").replace("）", ")").replace("(", "(").replace(")", ")")
    return s


def main():
    xlsx = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_XLSX
    out_path = sys.argv[2] if len(sys.argv) > 2 else "dedup_a.json"
    if not os.path.exists(xlsx):
        sys.exit("找不到表格文件：" + xlsx + "\n请指定路径：python build_dedup.py 你的表格.xlsx")

    wb = openpyxl.load_workbook(xlsx, read_only=True)
    ws = wb.worksheets[0]
    seen = set()
    names = []
    for row in ws.iter_rows(values_only=True):
        raw = row[0] if row else None
        if not raw:
            continue
        name = str(raw).strip()
        if not name:
            continue
        key = norm(name)
        if key in seen:
            continue
        seen.add(key)
        names.append(name)

    payload = {
        "app": "grt-dedup-a",
        "exportedAt": "",
        "names": names,
    }
    with io.open(out_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)

    print("去重库A已导出：共 %d 家（标准化去重后） -> %s" % (len(names), out_path))
    print("在网页工具中上传该文件即可载入；该文件已加入 .gitignore，不会进入仓库。")


if __name__ == "__main__":
    main()
