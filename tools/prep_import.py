"""Unpack the FCS-cloud-*.zip exports, shrink each PDF, and repack into import zips of <= 28 MB.
Entry names must be <32-hex aid>.<ext>; anything else is ignored. Writes a report to OUT/report.json."""
import sys, os, re, json, zipfile, subprocess, shutil
SRC, WORK, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
SHRINK = "/home/claude/cloud/tools/shrink_pdf.py"
LIMIT = 28 * 1024 * 1024
want = json.load(open("/home/claude/cloud_include.json"))
os.makedirs(WORK, exist_ok=True); os.makedirs(OUT, exist_ok=True)
pat = re.compile(r"^([0-9a-f]{32})(\.(pdf|png|jpg|jpeg|webp))?$", re.I)
got, bad = {}, []
for z in sorted(os.listdir(SRC)):
    if not z.endswith(".zip"): continue
    with zipfile.ZipFile(os.path.join(SRC, z)) as zf:
        for info in zf.infolist():
            name = os.path.basename(info.filename)
            m = pat.match(name)
            if not m or info.is_dir(): bad.append(info.filename); continue
            dst = os.path.join(WORK, "raw_" + name.lower())
            with zf.open(info) as r, open(dst, "wb") as w: shutil.copyfileobj(r, w)
            got[m.group(1).lower()] = dst
raw_total = sum(os.path.getsize(p) for p in got.values())
small = {}
for i, (aid, p) in enumerate(sorted(got.items())):
    out = os.path.join(WORK, os.path.basename(p)[4:])
    if p.lower().endswith(".pdf"):
        r = subprocess.run(["python3", "-I", SHRINK, p, out], capture_output=True, timeout=300)
        if r.returncode or not os.path.exists(out) or os.path.getsize(out) >= os.path.getsize(p):
            shutil.copy(p, out)
    else:
        shutil.copy(p, out)
    small[aid] = out
    if i % 50 == 0: print(i, "of", len(got), flush=True)
# repack, largest first into bins
items = sorted(small.items(), key=lambda kv: -os.path.getsize(kv[1]))
bins = []
for aid, p in items:
    s = os.path.getsize(p)
    for b in bins:
        if b["size"] + s <= LIMIT: b["files"].append(p); b["size"] += s; break
    else: bins.append({"files": [p], "size": s})
names = []
for n, b in enumerate(bins, 1):
    fn = os.path.join(OUT, f"FCS-cloud-import-{n:02d}-of-{len(bins):02d}.zip")
    with zipfile.ZipFile(fn, "w", zipfile.ZIP_STORED) as zf:
        for p in b["files"]: zf.write(p, os.path.basename(p))
    names.append(fn)
small_total = sum(os.path.getsize(p) for p in small.values())
missing = sorted(set(want) - set(got))
rep = {"files": len(got), "raw_mb": round(raw_total / 1e6, 1), "small_mb": round(small_total / 1e6, 1),
       "zips": [os.path.basename(n) for n in names], "max_zip_mb": round(max(os.path.getsize(n) for n in names) / 1e6, 1),
       "missing_from_exports": missing, "ignored_entries": bad[:20], "unexpected": sorted(set(got) - set(want))[:20]}
json.dump(rep, open(os.path.join(OUT, "report.json"), "w"), indent=1)
print(json.dumps({k: v for k, v in rep.items() if k != "zips"}, indent=1), len(names), "zips")
