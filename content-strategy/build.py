#!/usr/bin/env python3
"""Builds the DREM Book content calendar from plan_data.py.

    python3 build.py

Writes:
  DREM-Book-Content-Calendar-2026-2027.xlsx   the day-by-day calendar (Excel / Google Sheets)
  plan.json                                   the same plan as data
  strategy.html                               the strategy page (published as an artifact)
"""
import json
from collections import Counter
from datetime import date, timedelta
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

import plan_data as P

HERE = Path(__file__).parent
START, END = date(2026, 10, 1), date(2027, 12, 31)
XLSX = HERE / "DREM-Book-Content-Calendar-2026-2027.xlsx"

SLOT_DAYS = {0: "mon", 2: "wed", 4: "fri", 6: "sun"}  # weekday -> slot
BLOG_DAY, NEWSLETTER_DAY = 1, 3  # Tuesday, first Thursday of the month


def phase_for(d):
    for ph in P.PHASES:
        if date.fromisoformat(ph["start"]) <= d <= date.fromisoformat(ph["end"]):
            return ph
    raise ValueError(d)


def month_key(d):
    return f"{d.year}-{d.month:02d}"


def month_label(d):
    return d.strftime("%b %Y")


def cta(pillar, phase, channel):
    p = phase["id"]
    if channel == "Blog":
        return {1: "Get the free Manuscript Readiness Checklist (newsletter sign-up)",
                2: "Book a discovery call",
                3: "Start your book: check this season's production deadline"}[p]
    if channel == "Blog promo":
        return "Read the full post (link in bio)"
    return {
        "L": {1: "Save this. Free Manuscript Readiness Checklist: link in bio",
              2: "Save this and share it with a writer friend",
              3: "Ready to start? Send us a message"}[p],
        "C": "Answer in the comments",
        "D": "Share this with a writer who needs it",
        "B": "Ask us anything about the process" if p < 3 else "Send us a message to start your book",
        "O": "Send us a message to book",
    }[pillar]


def build_rows():
    rows = []
    used = Counter()  # (month, slot) -> next index
    blogs_by_date = {}

    def take(d, slot):
        mk = month_key(d)
        items = P.MONTHS[mk][slot]
        i = used[(mk, slot)]
        used[(mk, slot)] += 1
        if i >= len(items) or not items[i][0]:
            raise SystemExit(f"plan_data.py: {mk} needs another '{slot}' entry for {d}")
        return items[i]

    def add(d, channel, slot, pillar, fmt, topic, keyword="", platforms=""):
        ph = phase_for(d)
        label, gen = P.FORMATS.get(fmt, ("Article" if channel == "Blog" else "Email", ""))
        rows.append({
            "date": d.isoformat(), "day": d.strftime("%a"), "week": ((d - START).days + START.weekday()) // 7 + 1,
            "month": month_label(d), "mk": month_key(d), "phase": f"{ph['id']}. {ph['name']}",
            "theme": P.MONTHS[month_key(d)]["theme"], "channel": channel, "slot": slot,
            "pillar": P.PILLARS.get(pillar, ""), "format": label, "topic": topic,
            "cta": cta(pillar, ph, channel) if channel in ("Social", "Blog", "Blog promo") else "",
            "platforms": platforms, "keyword": keyword, "generator": gen,
        })

    for d_str, channel, pillar, fmt, topic in P.SPECIAL:
        d = date.fromisoformat(d_str)
        if channel == "Blog":
            blogs_by_date[d] = topic
            add(d, "Blog", "Launch", pillar, "", topic, "self-publishing services", P.PLATFORMS["blog"])
        else:
            add(d, "Social", "Launch", pillar, fmt, topic, platforms=P.PLATFORMS["fri"])

    d = START
    while d <= END:
        mk = month_key(d)
        m = P.MONTHS[mk]
        wd = d.weekday()
        if wd == BLOG_DAY:
            title, kw = take(d, "blogs")
            blogs_by_date[d] = title
            add(d, "Blog", "Tue blog", "L", "", title, kw, P.PLATFORMS["blog"])
        if wd == NEWSLETTER_DAY and d.day <= 7:
            add(d, "Newsletter", "Monthly email", "", "", m["newsletter"], platforms=P.PLATFORMS["newsletter"])
        if wd in SLOT_DAYS:
            slot = SLOT_DAYS[wd]
            if slot == "wed":
                title = blogs_by_date.get(d - timedelta(days=1))
                if title:
                    add(d, "Blog promo", "Wed blog promo", "L", "PROMO",
                        f"Key takeaway from this week's blog: {title}", platforms=P.PLATFORMS["wed"])
            else:
                pillar, fmt, topic = take(d, slot)
                plats = P.PLATFORMS["video"] if fmt == "REEL" else P.PLATFORMS[slot]
                add(d, "Social", {"mon": "Mon", "fri": "Fri", "sun": "Sun"}[slot] + " post", pillar, fmt, topic, platforms=plats)
        d += timedelta(days=1)

    for d_str, event, regions, idea, confirm in P.KEY_DATES:
        d = date.fromisoformat(d_str)
        add(d, "Key date", "Story", "", "", f"{event}: {idea}" + (" (confirm date)" if confirm else ""),
            platforms=P.PLATFORMS["key"])

    order = {"Newsletter": 0, "Blog": 1, "Blog promo": 2, "Social": 3, "Key date": 4}
    rows.sort(key=lambda r: (r["date"], order[r["channel"]]))
    return rows


# ---------------------------------------------------------------- spreadsheet
MIDNIGHT, EMBER, MOON, PAPER, LINE = "1E2147", "C4470E", "F4E7A1", "F7F2E8", "E3DDCF"
F = "Arial"
HEAD_FONT = Font(name=F, bold=True, color="FFFFFF", size=10)
HEAD_FILL = PatternFill("solid", fgColor=MIDNIGHT)
BODY = Font(name=F, size=10)
BOLD = Font(name=F, size=10, bold=True)
WRAP = Alignment(wrap_text=True, vertical="top")
THIN = Border(bottom=Side(style="thin", color=LINE))
CHANNEL_FILL = {
    "Blog": PatternFill("solid", fgColor=MOON),
    "Newsletter": PatternFill("solid", fgColor="E7F1F3"),
    "Key date": PatternFill("solid", fgColor=PAPER),
}


def header(ws, cols, widths, row=1):
    for i, (c, w) in enumerate(zip(cols, widths), 1):
        cell = ws.cell(row=row, column=i, value=c)
        cell.font, cell.fill = HEAD_FONT, HEAD_FILL
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.row_dimensions[row].height = 30


def title(ws, text, sub):
    ws["A1"] = text
    ws["A1"].font = Font(name=F, size=16, bold=True, color=MIDNIGHT)
    ws["A2"] = sub
    ws["A2"].font = Font(name=F, size=10, italic=True, color="4A4D63")


def write_xlsx(rows):
    wb = Workbook()

    # --- Read me
    ws = wb.active
    ws.title = "Read me"
    title(ws, "DREM Book content calendar: Oct 1, 2026 to Dec 31, 2027",
          "Generated from content-strategy/plan_data.py. Pair with the strategy page.")
    lines = [
        ("How to use this workbook", ""),
        ("Calendar", "Every planned post, blog, newsletter and key-date story, one row each. Filter by month, channel or pillar."),
        ("Status column", "The only column to fill in as you work: Idea → Drafted → Designed → Scheduled → Posted. Owner and Notes are free text."),
        ("Blog plan", "The 65 blog posts with their search keyword and the Wednesday promo date."),
        ("Monthly themes", "Theme, campaign and newsletter topic for each of the 15 months."),
        ("Key dates", "Holidays, awareness days and book events. Rows marked 'confirm date' change every year: check before posting."),
        ("Summary", "Live counts by month and pillar mix by phase (formulas; they update when you add rows)."),
        ("", ""),
        ("Weekly rhythm", ""),
        ("Monday", "Learn post (carousel, tip or short video)"),
        ("Tuesday", "Blog post goes live on the website"),
        ("Wednesday", "Blog promo: one key takeaway, linking to the blog"),
        ("Friday", "Offer or behind-the-book post (weighted toward offers in phase 3)"),
        ("Sunday", "Community or Dream post (question, poll, quote)"),
        ("First Thursday", "Monthly newsletter"),
        ("", ""),
        ("Example row", "2026-10-05 · Mon post · Learn · Tip graphic · \"3 signs your manuscript is ready…\" · Status: Designed"),
        ("Posts marked 'sample post 01–08'", "Already designed in social-post-generator/content/posts.json."),
        ("Generator type", "The post type to use in the social post generator. Blank means filmed or written natively in the app."),
        ("Client stories and team posts", "Use real people only, with written permission. Never invent testimonials or numbers."),
    ]
    for i, (a, b) in enumerate(lines, 4):
        ws.cell(row=i, column=1, value=a).font = BOLD if (a and not b) or a in ("Example row",) else BODY
        ws.cell(row=i, column=2, value=b).font = BODY
        ws.cell(row=i, column=2).alignment = WRAP
    ws.column_dimensions["A"].width = 30
    ws.column_dimensions["B"].width = 100

    # --- Calendar
    ws = wb.create_sheet("Calendar")
    cols = ["Date", "Day", "Week", "Month", "Phase", "Monthly theme", "Channel", "Slot", "Pillar", "Format",
            "Topic / title", "Call to action", "Platforms", "Search keyword", "Generator type", "Status", "Owner", "Notes"]
    widths = [11, 5, 6, 10, 17, 24, 11, 14, 14, 20, 58, 36, 40, 26, 13, 11, 12, 24]
    header(ws, cols, widths)
    keys = ["date", "day", "week", "month", "phase", "theme", "channel", "slot", "pillar", "format",
            "topic", "cta", "platforms", "keyword", "generator"]
    for r, row in enumerate(rows, 2):
        for c, k in enumerate(keys, 1):
            v = date.fromisoformat(row[k]) if k == "date" else row[k]
            cell = ws.cell(row=r, column=c, value=v)
            cell.font, cell.alignment, cell.border = BODY, WRAP, THIN
            if row["channel"] in CHANNEL_FILL:
                cell.fill = CHANNEL_FILL[row["channel"]]
        ws.cell(row=r, column=1).number_format = "yyyy-mm-dd"
        ws.cell(row=r, column=16, value="Idea").font = BODY
        for c in (16, 17, 18):
            ws.cell(row=r, column=c).border = THIN
    last = len(rows) + 1
    dv = DataValidation(type="list", formula1='"Idea,Drafted,Designed,Scheduled,Posted,Skipped"', allow_blank=True)
    dv.add(f"P2:P{last}")
    ws.add_data_validation(dv)
    ws.freeze_panes = "B2"
    ws.auto_filter.ref = f"A1:R{last}"

    # --- Blog plan
    ws = wb.create_sheet("Blog plan")
    header(ws, ["Publish (Tue)", "Title", "Search keyword", "Monthly theme", "Phase", "Length", "Call to action",
                "Promo (Wed)", "Status"], [12, 62, 34, 24, 17, 16, 44, 12, 11])
    blog_rows = [r for r in rows if r["channel"] == "Blog"]
    for i, b in enumerate(blog_rows, 2):
        d = date.fromisoformat(b["date"])
        vals = [d, b["topic"], b["keyword"], b["theme"], b["phase"], "1,200–1,800 words", b["cta"],
                d + timedelta(days=1) if d.weekday() == BLOG_DAY else d, "Idea"]
        for c, v in enumerate(vals, 1):
            cell = ws.cell(row=i, column=c, value=v)
            cell.font, cell.alignment, cell.border = BODY, WRAP, THIN
        ws.cell(row=i, column=1).number_format = ws.cell(row=i, column=8).number_format = "yyyy-mm-dd"
    ws.freeze_panes = "C2"
    ws.auto_filter.ref = f"A1:I{len(blog_rows) + 1}"
    dv2 = DataValidation(type="list", formula1='"Idea,Outlined,Drafted,Edited,Published"', allow_blank=True)
    dv2.add(f"I2:I{len(blog_rows) + 1}")
    ws.add_data_validation(dv2)

    # --- Monthly themes
    ws = wb.create_sheet("Monthly themes")
    header(ws, ["Month", "Phase", "Theme", "What the month is about", "Campaign", "Newsletter topic"],
           [10, 17, 26, 60, 50, 50])
    for i, (mk, m) in enumerate(P.MONTHS.items(), 2):
        d = date.fromisoformat(mk + "-01")
        ph = phase_for(d)
        for c, v in enumerate([month_label(d), f"{ph['id']}. {ph['name']}", m["theme"], m["summary"], m["campaign"], m["newsletter"]], 1):
            cell = ws.cell(row=i, column=c, value=v)
            cell.font, cell.alignment, cell.border = BODY, WRAP, THIN
        ws.cell(row=i, column=3).font = BOLD

    # --- Key dates
    ws = wb.create_sheet("Key dates")
    header(ws, ["Date", "Event", "Regions", "Post idea", "Confirm date?"], [11, 48, 24, 60, 13])
    for i, (d_str, event, regions, idea, confirm) in enumerate(P.KEY_DATES, 2):
        for c, v in enumerate([date.fromisoformat(d_str), event, regions, idea, "Yes" if confirm else ""], 1):
            cell = ws.cell(row=i, column=c, value=v)
            cell.font, cell.alignment, cell.border = BODY, WRAP, THIN
        ws.cell(row=i, column=1).number_format = "yyyy-mm-dd"
    ws.freeze_panes = "B2"

    # --- Summary (formulas)
    ws = wb.create_sheet("Summary")
    title(ws, "Summary", "Counts come from the Calendar sheet with COUNTIFS, so they update as you edit it.")
    channels = ["Social", "Blog promo", "Blog", "Newsletter", "Key date"]
    n = len(rows) + 1
    rng = lambda col: f"Calendar!${col}$2:${col}${n}"
    header(ws, ["Month"] + channels + ["Total"], [12, 10, 12, 8, 12, 10, 10], row=4)
    months = list(dict.fromkeys(r["month"] for r in rows))
    for i, mo in enumerate(months, 5):
        ws.cell(row=i, column=1, value=mo).font = BODY
        for c, ch in enumerate(channels, 2):
            ws.cell(row=i, column=c, value=f'=COUNTIFS({rng("D")},$A{i},{rng("G")},"{ch}")').font = BODY
        ws.cell(row=i, column=7, value=f"=SUM(B{i}:F{i})").font = BOLD
    tot = 5 + len(months)
    ws.cell(row=tot, column=1, value="Total").font = BOLD
    for c in range(2, 8):
        col = get_column_letter(c)
        ws.cell(row=tot, column=c, value=f"=SUM({col}5:{col}{tot - 1})").font = BOLD

    # pillar mix per phase (social posts only)
    start = tot + 3
    ws.cell(row=start - 1, column=1, value="Pillar mix of social posts and blog promos by phase (planned vs target)").font = Font(name=F, size=12, bold=True, color=MIDNIGHT)
    pillars = list(P.PILLARS.values())
    header(ws, ["Phase"] + pillars + ["Total"], [12] * 7, row=start)
    ws.column_dimensions["A"].width = 22
    for j, ph in enumerate(P.PHASES):
        r = start + 1 + j * 3
        name = f"{ph['id']}. {ph['name']}"
        ws.cell(row=r, column=1, value=name).font = BOLD
        ws.cell(row=r + 1, column=1, value="  share of posts").font = BODY
        ws.cell(row=r + 2, column=1, value="  target (strategy)").font = BODY
        for c, pl in enumerate(pillars, 2):
            ws.cell(row=r, column=c, value=f'=COUNTIFS({rng("E")},$A{r},{rng("I")},"{pl}",{rng("G")},"Social")+COUNTIFS({rng("E")},$A{r},{rng("I")},"{pl}",{rng("G")},"Blog promo")').font = BODY
            col = get_column_letter(c)
            pc = ws.cell(row=r + 1, column=c, value=f"=IF($G{r}=0,0,{col}{r}/$G{r})")
            pc.font, pc.number_format = BODY, "0%"
            key = [k for k, v in P.PILLARS.items() if v == pl][0]
            tc = ws.cell(row=r + 2, column=c, value=ph["mix"][key] / 100)
            tc.font, tc.number_format = Font(name=F, size=10, color="0000FF"), "0%"
        ws.cell(row=r, column=7, value=f"=SUM(B{r}:F{r})").font = BOLD
    note = start + 1 + len(P.PHASES) * 3
    ws.cell(row=note, column=1, value="Blue figures are the target mix from the strategy (inputs). Blog promos count as Learn.").font = Font(name=F, size=9, italic=True)

    wb.move_sheet("Summary", offset=-4)
    # Excel and Google Sheets compute every formula when the file is opened.
    wb.calculation.fullCalcOnLoad = True
    wb.save(XLSX)


def write_json(rows):
    months = []
    for mk, m in P.MONTHS.items():
        d = date.fromisoformat(mk + "-01")
        mrows = [r for r in rows if r["mk"] == mk]
        c = Counter(r["channel"] for r in mrows)
        months.append({**{k: m[k] for k in ("theme", "summary", "campaign", "newsletter")}, "key": mk,
                       "label": month_label(d), "phase": phase_for(d)["id"],
                       "counts": {"social": c["Social"] + c["Blog promo"], "blog": c["Blog"], "newsletter": c["Newsletter"], "key": c["Key date"]}})
    slim = [{k: r[k] for k in ("date", "day", "mk", "channel", "pillar", "format", "topic", "cta", "platforms", "keyword")} for r in rows]
    data = {"phases": P.PHASES, "pillars": P.PILLARS, "months": months, "rows": slim,
            "keyDates": [dict(zip(("date", "event", "regions", "idea", "confirm"), k)) for k in P.KEY_DATES],
            "totals": dict(Counter(r["channel"] for r in rows))}
    (HERE / "plan.json").write_text(json.dumps(data, ensure_ascii=False, indent=1))
    page = (HERE / "strategy.template.html").read_text()
    (HERE / "strategy.html").write_text(page.replace("/*PLAN_DATA*/", json.dumps(data, ensure_ascii=False).replace("</", "<\\/")))
    return data


if __name__ == "__main__":
    rows = build_rows()
    write_xlsx(rows)
    data = write_json(rows)
    print(f"{len(rows)} rows:", data["totals"])
    print(f"Wrote {XLSX.name}, plan.json and strategy.html")
