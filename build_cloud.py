"""Build the cloud (Ample) copy of the FCS Site QA app from the same source as the claude.ai app.
Usage: python3 build_cloud.py   (expects ../appsrc/app/build.py output fcs-site-qa.html)"""
import os, re, shutil, subprocess
HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "..", "appsrc", "app")
subprocess.run(["python3", "build.py"], cwd=APP, check=True, stdout=subprocess.DEVNULL)
html = open(os.path.join(APP, "fcs-site-qa.html"), encoding="utf-8").read()
shim = open(os.path.join(HERE, "shim.js"), encoding="utf-8").read()

def rep(old, new, count=1):
    global html
    assert html.count(old) == count, (old[:70], html.count(old))
    html = html.replace(old, new)

# links point at this site, not claude.ai
rep('const APP_LINK="https://claude.ai/artifact/AmKbv84nvoNo9tpsQothz9";', 'const APP_LINK=location.origin+"/";')
# files copied to the cloud open in the built-in viewer; anything not copied keeps its claude.ai file-page link
rep('const fUrl=f=>f&&f.st?', 'const fUrl=f=>f&&f.st&&!(window.__CLOUD_FILES&&window.__CLOUD_FILES.has(f.aid))?')
# the shim must run before the app script
i = html.index("<script")
html = html[:i] + "<script>\n" + shim + "\n</script>\n" + html[i:]
doc = ('<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">'
       '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
       '<link rel="icon" href="/logo.png">'
       '<style>body{margin:0}[hidden]{display:none!important}</style></head><body>\n' + html + '\n</body></html>\n')
os.makedirs(os.path.join(HERE, "public"), exist_ok=True)
open(os.path.join(HERE, "public", "index.html"), "w", encoding="utf-8").write(doc)
shutil.copy(os.path.join(APP, "logo.png"), os.path.join(HERE, "public", "logo.png"))
print("built public/index.html", len(doc), "bytes")
