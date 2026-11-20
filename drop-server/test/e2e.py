"""Browser test for f3 drop v2 rooms: iPhone + Windows PC, plus a friend's Android + Mac.

Runs the real page and the real server on this machine with headless Chrome.
Usage: python3 -I drop-server/test/e2e.py <repo-dir> <chrome-path>
Prints one PASS/FAIL line per acceptance test.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

REPO = os.path.abspath(sys.argv[1])
CHROME = sys.argv[2]
SITE_PORT, API_PORT = 8000, 8787
SITE = f"http://127.0.0.1:{SITE_PORT}"
API = f"http://127.0.0.1:{API_PORT}"
ITEM_TTL_MS = 15000
WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def wait_for(fn, timeout=10.0, step=0.05):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            v = fn()
        except Exception:
            v = None
        if v:
            return time.time() - t0
        time.sleep(step)
    return None


def get(path, token=None):
    req = urllib.request.Request(API + path, headers={"Authorization": "Bearer " + token} if token else {})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"status": e.code}


# ---- test copy of the site, pointed at the local server ----
work = tempfile.mkdtemp(prefix="f3drop-e2e-")
site = os.path.join(work, "site")
data = os.path.join(work, "data")
os.mkdir(data)
shutil.copytree(REPO, site, ignore=shutil.ignore_patterns(".git"))
idx = os.path.join(site, "code", "index.html")
html = open(idx, encoding="utf-8").read()
html = html.replace('content="https://api2.f3.sa"', f'content="{API}"').replace("connect-src 'self' https://api2.f3.sa", f"connect-src 'self' {API}")
assert API in html, "test could not point the page at the local server"
open(idx, "w", encoding="utf-8").write(html)

env = dict(os.environ, PORT=str(API_PORT), DATA_DIR=data, ALLOW_ORIGIN=SITE, ITEM_TTL_MS=str(ITEM_TTL_MS), SWEEP_MS="200", STATS_SAVE_MS="500")
srv = subprocess.Popen(["node", os.path.join(REPO, "drop-server", "server.js")], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
srv.stdout.readline()
web = subprocess.Popen([sys.executable, "-I", "-m", "http.server", str(SITE_PORT), "--bind", "127.0.0.1", "--directory", site],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)

SAMPLE = 'def hello(name):\n    # say hi\n    return f"hi {name}"  # ' + "x" * 300 + "\nprint(hello('f3'))\n"
BACK = "SELECT 1 AS back_from_phone;"
FRIEND = "friend-only-secret-line"


def code_of(pg):
    import re
    wait_for(lambda: re.fullmatch(r"[0-9A-Z]{4}", pg.inner_text("#code").strip()), timeout=15)
    return pg.inner_text("#code").strip()


def room_rec(pg):
    return pg.evaluate("JSON.parse(localStorage.getItem('f3drop.room.v2'))")


def storage_dump(pg):
    return pg.evaluate("""async () => ({
        ls: Object.keys(localStorage).map(k => k + '=' + localStorage.getItem(k)),
        ss: Object.keys(sessionStorage),
        idb: indexedDB.databases ? (await indexedDB.databases()).map(d => d.name) : []
    })""")


try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, headless=True)
        perms = ["clipboard-read", "clipboard-write"]
        iphone = dict(p.devices["iPhone 14"]); iphone.pop("default_browser_type", None)
        pixel = dict(p.devices["Pixel 7"]); pixel.pop("default_browser_type", None)
        pc_ctx = browser.new_context(viewport={"width": 1280, "height": 800}, user_agent=WIN_UA, permissions=perms)
        phone_ctx = browser.new_context(**iphone, permissions=perms)
        friend_ctx = browser.new_context(**pixel, permissions=perms)
        friend_pc_ctx = browser.new_context(viewport={"width": 1280, "height": 800}, user_agent=MAC_UA, permissions=perms)

        hosts, csp = [], []
        pages = []
        for ctx in (pc_ctx, phone_ctx, friend_ctx, friend_pc_ctx):
            ctx.on("request", lambda r: hosts.append(r.url))
        pc, phone, friend, friend_pc = (c.new_page() for c in (pc_ctx, phone_ctx, friend_ctx, friend_pc_ctx))
        for pg in (pc, phone, friend, friend_pc):
            pg.on("console", lambda m: csp.append(m.text) if "Content Security Policy" in m.text or "Refused" in m.text else None)

        # ---- stats link: claim it once, from the page ----
        pc.goto(f"{SITE}/code/#stats")
        pc.wait_for_selector("#statsClaim:not([hidden])")
        pc.click("#claimBtn")
        pc.wait_for_selector("#statsLink:not([hidden])")
        stats_link = pc.inner_text("#statsUrl").strip()
        STATS_TOK = stats_link.split("#s=")[1]
        pc.wait_for_selector("#statsBody:not([hidden])")
        check("Stats link is made once and opens the stats page", "#s=" in stats_link and len(STATS_TOK) == 43)
        pc.goto(f"{SITE}/code/#stats")
        pc.wait_for_selector("#statsBody:not([hidden])")
        friend_pc.goto(f"{SITE}/code/#stats")
        friend_pc.wait_for_selector("#statsLocked:not([hidden])")
        check("Someone without the stats link cannot see stats or claim them", friend_pc.locator("#statsClaim").is_hidden())

        # ---- T1: iPhone opens the site and gets a room + code ----
        t0 = time.time()
        phone.goto(f"{SITE}/code/")
        phone_code = code_of(phone)
        check("T1 iPhone: room and 4-character code ready on open", len(phone_code) == 4, f"{phone_code} in {time.time() - t0:.1f}s")

        # ---- T2: PC types the code and is paired, no other step ----
        pc.goto(f"{SITE}/code/")
        code_of(pc)  # PC got its own room first
        pc_own_room = room_rec(pc)["id"]
        pc.fill("#joinIn", phone_code.lower())
        t0 = time.time()
        pc.click("#joinBtn")
        pc.wait_for_selector("#pairedBox:not([hidden])", timeout=15000)
        joined = time.time() - t0
        got = wait_for(lambda: phone.is_visible("#pairedBox") and "Windows PC" in phone.inner_text("#pairedName"), timeout=10)
        check("T2 PC joins by typing the code; both show paired", got is not None, f"join {joined:.1f}s")
        check("T2 device detection: iPhone sees 'Windows PC', PC sees 'iPhone'",
              "Windows PC" in phone.inner_text("#pairedName") and "iPhone" in pc.inner_text("#pairedName"))
        check("T2 both devices are in the same room", room_rec(pc)["id"] == room_rec(phone)["id"])
        check("T2 PC's unused room was closed", get(f"/v1/rooms/{pc_own_room}", room_rec(pc)["token"]).get("status") == 404)

        # ---- T3: send PC -> iPhone ----
        pc.fill("#paste", SAMPLE)
        pc.select_option("#lang", "python")
        t0 = time.time()
        pc.click("#sendBtn")
        got = wait_for(lambda: phone.locator(".card").count() == 1, timeout=10)
        check("T3 PC -> iPhone in under 10 s", got is not None and got < 10, f"{got:.1f}s" if got else "not seen")
        check("T3 code shows correctly on the iPhone", phone.locator(".card code").inner_text().strip() == SAMPLE.strip())
        check("T3 highlighting works (vendored, no CDN)", phone.locator(".card .token").count() > 0)
        sw = phone.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
        check("T3 iPhone screen: no sideways scroll with long lines", sw[0] <= sw[1], f"{sw[0]} <= {sw[1]}")

        # ---- T4: server holds only locked text ----
        rec = room_rec(phone)
        srv_view = get(f"/v1/rooms/{rec['id']}", rec["token"])
        blob = json.dumps(srv_view)
        check("T4 server holds only locked text", len(srv_view.get("items", [])) == 1 and "hello" not in blob and "def " not in blob)

        # ---- T5: copy on iPhone deletes on both ----
        phone.click(".card .copy")
        clip = phone.evaluate("navigator.clipboard.readText()")
        check("T5 copy puts the exact code on the iPhone clipboard", clip == SAMPLE)
        got = wait_for(lambda: phone.locator(".card").count() == 0 and pc.locator(".card").count() == 0, timeout=6)
        check("T5 after copy it is gone on both devices", got is not None, f"{got:.1f}s" if got else "still there")
        check("T5 and gone on the server", len(get(f"/v1/rooms/{rec['id']}", rec["token"]).get("items", [1])) == 0)

        # ---- T6: other direction ----
        phone.fill("#paste", BACK)
        phone.click("#sendBtn")
        got = wait_for(lambda: pc.locator(".card").count() == 1, timeout=10)
        check("T6 iPhone -> PC works too", got is not None and pc.locator(".card code").inner_text().strip() == BACK)
        pc.click(".card .copy")
        check("T6 PC clipboard has it", pc.evaluate("navigator.clipboard.readText()") == BACK)

        # ---- T7: nothing readable left in browser storage ----
        leaks = []
        for pg in (pc, phone):
            d = storage_dump(pg)
            leaks += [x for x in d["ls"] if "hello" in x or "back_from_phone" in x] + d["ss"] + d["idb"]
        check("T7 no snippet text kept in browser storage on either device", not leaks, json.dumps(leaks)[:200])

        # ---- T8: reload keeps the room for the day ----
        pc.reload()
        pc.wait_for_selector("#pairedBox:not([hidden])", timeout=10000)
        check("T8 PC reload: still paired with the iPhone, no new code needed", "iPhone" in pc.inner_text("#pairedName"))
        left = pc.text_content("#roomLeft")
        check("T8 room end time is shown", "ends in 23 h" in left or "ends in 24 h" in left, left)

        # ---- T9: not copied -> gone after the item time ----
        pc.fill("#paste", "expire me")
        pc.click("#sendBtn")
        wait_for(lambda: phone.locator(".card").count() == 1, timeout=10)
        got = wait_for(lambda: phone.locator(".card").count() == 0 and pc.locator(".card").count() == 0, timeout=ITEM_TTL_MS / 1000 + 6)
        check(f"T9 not copied: gone on both after {ITEM_TTL_MS // 1000} s (5 min live)", got is not None)

        # ---- T10: friend gets his own room, joins with a shared link ----
        friend.goto(f"{SITE}/code/")
        fcode = code_of(friend)
        friend_pc.goto(f"{SITE}/code/#{fcode}")
        friend_pc.wait_for_selector("#pairedBox:not([hidden])", timeout=15000)
        check("T10 friend: link with the code joins straight away", "Android phone" in friend_pc.inner_text("#pairedName"))
        check("T10 the code is removed from the address bar", "#" not in friend_pc.url, friend_pc.url)
        check("T10 friend's room is separate from yours", room_rec(friend)["id"] != room_rec(phone)["id"])
        friend.fill("#paste", FRIEND)
        friend.click("#sendBtn")
        wait_for(lambda: friend_pc.locator(".card").count() == 1, timeout=10)
        time.sleep(2)
        check("T10 friend's item reaches his Mac, never your devices",
              friend_pc.locator(".card").count() == 1 and phone.locator(".card").count() == 0 and pc.locator(".card").count() == 0)

        # ---- T11: wrong code ----
        friend_pc.click(".settings summary")
        friend_pc.fill("#joinIn2", "ZZZZ")
        friend_pc.click("#joinBtn2")
        got = wait_for(lambda: "Wrong or expired" in friend_pc.inner_text("#toast"), timeout=6)
        check("T11 wrong code: clear message, still in own room", got is not None and "Android phone" in friend_pc.inner_text("#pairedName"))

        # ---- T12: Not me - end room ----
        old_room = room_rec(phone)["id"]
        phone.click("#notMeBtn")
        phone.click("#notMeBtn")
        new_code = code_of(phone)
        got = wait_for(lambda: pc.is_visible("#pairBox") and pc.locator("#pairedBox").is_hidden(), timeout=10)
        check("T12 'Not me - end room': room ends for both, iPhone gets a new code",
              got is not None and room_rec(phone)["id"] != old_room and len(new_code) == 4)
        check("T12 PC is out of the old room", get(f"/v1/rooms/{old_room}", room_rec(pc)["token"]).get("status") == 404)

        # ---- T13: stats show counts only ----
        st = get("/v1/stats", STATS_TOK)
        today = st["days"][0]
        text = json.dumps(st)
        check("T13 stats count visits by device", today["visits"] >= 4 and today["dev"].get("iphone", 0) >= 1
              and today["dev"].get("windows", 0) >= 1 and today["dev"].get("android", 0) >= 1, json.dumps(today["dev"]))
        check("T13 stats count rooms, joins, wrong codes, sends, copies, expiries, ends",
              today["rooms"] >= 4 and today["joins"] >= 2 and today["wrong"] >= 1 and today["sent"] >= 4
              and today["copied"] >= 2 and today["expired"] >= 1 and today["ended"] >= 1, json.dumps(today))
        check("T13 stats hold no addresses and no content", "127.0.0.1" not in text and "hello" not in text and FRIEND not in text)
        pc.goto(f"{SITE}/code/#stats")
        pc.wait_for_selector("#statsBody:not([hidden])")
        check("T13 stats page shows it", "visit" in pc.inner_text("#days") and "open" in pc.inner_text("#live"))
        time.sleep(1)
        disk = sorted(os.listdir(data))
        file_text = open(os.path.join(data, "stats.json")).read()
        check("T13 on disk: only the counts file and the stats hash", disk == ["stats-auth", "stats.json"] and "127.0.0.1" not in file_text, str(disk))

        # ---- T15: dark and light themes ----
        dark_ctx = browser.new_context(**iphone, color_scheme="dark")
        dk = dark_ctx.new_page()
        dk.on("console", lambda m: csp.append(m.text) if "Content Security Policy" in m.text or "Refused" in m.text else None)
        dk.goto(f"{SITE}/code/")
        code_of(dk)
        bg = lambda pg: pg.evaluate("getComputedStyle(document.body).backgroundColor")
        check("T15 dark phone: page follows the device (dark)", bg(dk) == "rgb(22, 19, 17)", bg(dk))
        dk.click("#themeBtn")
        check("T15 tap theme: Light", dk.inner_text("#themeBtn") == "Light" and bg(dk) == "rgb(250, 247, 242)", bg(dk))
        dk.reload()
        code_of(dk)
        check("T15 choice is remembered after reload", dk.inner_text("#themeBtn") == "Light" and bg(dk) == "rgb(250, 247, 242)")
        dk.click("#themeBtn")
        check("T15 tap theme: Dark", dk.inner_text("#themeBtn") == "Dark" and bg(dk) == "rgb(22, 19, 17)")
        dk.click("#themeBtn")
        check("T15 tap theme: back to Auto", dk.inner_text("#themeBtn") == "Auto" and bg(dk) == "rgb(22, 19, 17)")
        check("T15 light device stays light on Auto", bg(phone) == "rgb(250, 247, 242)")

        # ---- T14: nothing loads from other sites; CSP clean ----
        others = sorted({h.split("/")[2] for h in hosts if not h.startswith(SITE) and not h.startswith(API)})
        check("T14 page loads nothing from other sites", not others, str(others))
        check("T14 no CSP errors", not csp, "; ".join(csp)[:300])
        browser.close()
finally:
    srv.terminate()
    web.terminate()
    shutil.rmtree(work, ignore_errors=True)

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
