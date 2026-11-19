"""Two-device browser test for f3 drop (laptop + phone-sized screen).

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
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def wait_for(fn, timeout=10.0, step=0.05):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = fn()
        if v:
            return time.time() - t0
        time.sleep(step)
    return None


# ---- test copy of the site, pointed at the local server ----
work = tempfile.mkdtemp(prefix="f3drop-e2e-")
site = os.path.join(work, "site")
shutil.copytree(REPO, site, ignore=shutil.ignore_patterns(".git"))
idx = os.path.join(site, "code", "index.html")
html = open(idx, encoding="utf-8").read()
html = html.replace('content="https://api.f3.sa"', f'content="{API}"').replace("connect-src 'self' https://api.f3.sa", f"connect-src 'self' {API}")
open(idx, "w", encoding="utf-8").write(html)


def keys():
    js = ("import {deriveKeys,newSecret} from '%s/code/crypto.js';"
          "const k=await deriveKeys(newSecret());"
          "console.log(JSON.stringify({secret:k.secret,token:k.token,code:k.serverCode}))") % site
    return json.loads(subprocess.check_output(["node", "--input-type=module", "-e", js], text=True))


K = keys()
auth_file = os.path.join(work, "auth")
open(auth_file, "w").write(K["code"] + "\n")


def start_server(ttl_ms):
    env = dict(os.environ, PORT=str(API_PORT), AUTH_FILE=auth_file, ALLOW_ORIGIN=SITE, TTL_MS=str(ttl_ms), SWEEP_MS="200")
    p = subprocess.Popen(["node", os.path.join(REPO, "drop-server", "server.js")], env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    p.stdout.readline()
    return p


def server_items(token):
    req = urllib.request.Request(API + "/v1/items", headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"status": e.code}


srv = start_server(300000)
web = subprocess.Popen([sys.executable, "-I", "-m", "http.server", str(SITE_PORT), "--bind", "127.0.0.1", "--directory", site],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(0.8)

SAMPLE = 'def hello(name):\n    # say hi\n    return f"hi {name}"  # ' + "x" * 300 + "\nprint(hello('f3'))\n"

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=CHROME, headless=True)
        perms = ["clipboard-read", "clipboard-write"]
        phone_dev = dict(p.devices["iPhone 14"])
        phone_dev.pop("default_browser_type", None)
        laptop_ctx = browser.new_context(viewport={"width": 1280, "height": 800}, permissions=perms)
        phone_ctx = browser.new_context(**phone_dev, permissions=perms)

        hosts, csp_errors = [], []
        for ctx in (laptop_ctx, phone_ctx):
            ctx.on("request", lambda r: hosts.append(r.url))
        laptop = laptop_ctx.new_page()
        phone = phone_ctx.new_page()
        for pg in (laptop, phone):
            pg.on("console", lambda m: csp_errors.append(m.text) if "Content Security Policy" in m.text or "Refused" in m.text else None)

        link = f"{SITE}/code/#{K['secret']}"
        laptop.goto(link)
        phone.goto(link)
        laptop.wait_for_selector("#inbox:not([hidden])")
        phone.wait_for_selector("#inbox:not([hidden])")
        check("Same one link opens the inbox on both devices", wait_for(lambda: "Connected" in laptop.inner_text("#status")) is not None)

        # T1: send from laptop, appears on phone
        laptop.fill("#paste", SAMPLE)
        laptop.select_option("#lang", "python")
        t0 = time.time()
        laptop.click("#sendBtn")
        got = wait_for(lambda: phone.locator(".card").count() == 1, timeout=10)
        check("T1 laptop -> phone in under 10 s", got is not None and got < 10, f"{got:.1f}s" if got else "not seen")
        check("Code shows correctly on the phone", phone.locator(".card code").inner_text().strip() == SAMPLE.strip())
        check("Highlighting works (vendored, no CDN)", phone.locator(".card .token").count() > 0)

        # T16: sender keeps nothing
        check("T16 sender's paste box is empty after send", laptop.input_value("#paste") == "")
        storage = laptop.evaluate("""async () => ({
            ls: Object.keys(localStorage).map(k => k + '=' + localStorage.getItem(k)),
            ss: Object.keys(sessionStorage),
            idb: indexedDB.databases ? (await indexedDB.databases()).map(d => d.name) : []
        })""")
        leaks = [x for x in storage["ls"] if K["secret"] in x or "hello" in x]
        check("T16 no code or key in browser storage", not leaks and not storage["ss"] and not storage["idb"], json.dumps(storage))

        # T9: no sideways scroll on the phone
        sw = phone.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
        check("T9 phone screen: no sideways scroll with long lines", sw[0] <= sw[1], f"{sw[0]} <= {sw[1]}")

        # T2: server copy is unreadable
        items = server_items(K["token"])["items"]
        check("T2 server holds only locked text", len(items) == 1 and "hello" not in json.dumps(items) and "def " not in json.dumps(items))

        # T12 + T13: copy on phone deletes everywhere
        laptop.wait_for_selector(".card")
        phone.click(".card .copy")
        clip = phone.evaluate("navigator.clipboard.readText()")
        check("Copy puts the exact code on the phone clipboard", clip == SAMPLE)
        gone = wait_for(lambda: laptop.locator(".card").count() == 0, timeout=5)
        check("T13 laptop screen clears within 3 s of the phone copy", gone is not None and gone < 3, f"{gone:.1f}s" if gone else "still there")
        check("T12 deleted on the server after copy", server_items(K["token"])["items"] == [])
        check("Toast says it was deleted on both devices", "Deleted on both devices" in phone.inner_text("#toast"))

        # T14: copy blocked -> nothing deleted
        blocked_ctx = browser.new_context(viewport={"width": 390, "height": 800})
        blocked_ctx.add_init_script("""
            Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('blocked')) } });
            document.execCommand = () => false;
        """)
        blocked = blocked_ctx.new_page()
        blocked.goto(link)
        laptop.fill("#paste", "blocked-copy-test")
        laptop.click("#sendBtn")
        blocked.wait_for_selector(".card .copy", timeout=8000)
        blocked.click(".card .copy")
        time.sleep(0.5)
        check("T14 copy blocked: message shown and nothing deleted",
              "Nothing was deleted" in blocked.inner_text("#toast") and len(server_items(K["token"])["items"]) == 1)

        # Delete button (no copy)
        blocked.click(".card .del")
        check("Delete button removes it on the server", wait_for(lambda: server_items(K["token"])["items"] == [], timeout=3) is not None)
        blocked_ctx.close()

        # T3: a wrong link opens nothing
        wrong = keys()
        wctx = browser.new_context()
        wpage = wctx.new_page()
        wpage.goto(f"{SITE}/code/#{wrong['secret']}")
        wpage.wait_for_selector("#start:not([hidden])", timeout=8000)
        check("T3 wrong link: refused with a clear message, nothing listed", "not the one your server knows" in wpage.inner_text("#startMsg") and wpage.locator(".card").count() == 0)
        wctx.close()

        # First-time setup on a fresh device: link + server code + setup script
        sctx = browser.new_context(permissions=perms)
        spage = sctx.new_page()
        spage.goto(f"{SITE}/code/")
        spage.wait_for_selector("#start:not([hidden])")
        ready = wait_for(lambda: spage.locator("#readyNote").is_visible(), timeout=5)
        check("Server already set up: 'Create my link' is hidden and the note explains why",
              ready is not None and not spage.locator("#firstBox").is_visible())
        spage.goto(f"{SITE}/code/#setup")
        spage.wait_for_selector("#firstBox:not([hidden])", timeout=5000)
        spage.click("#createBtn")
        spage.wait_for_selector("#setup:not([hidden])")
        new_link = spage.inner_text("#newLink")
        new_code = spage.inner_text("#newCode")
        time.sleep(0.5)
        spage.click("#copySetup")
        time.sleep(0.3)
        script = spage.evaluate("navigator.clipboard.readText()")
        check("Setup: makes a link and a 64-character server code", "/code/#" in new_link and len(new_code) == 64)
        check("Setup: copied script has the server code filled in", new_code in script and "PASTE_SERVER_CODE_HERE" not in script and script.startswith("#cloud-config"))
        sctx.close()

        # Send the link to another device (no share sheet here, so it copies)
        laptop.evaluate("Object.defineProperty(navigator, 'share', { value: undefined, configurable: true })")
        laptop.click("details.settings summary")
        laptop.click("#shareBtn")
        time.sleep(0.4)
        shared = laptop.evaluate("navigator.clipboard.readText()")
        check("'Send this link to my other device' hands over the working link", shared == link)
        laptop.click("details.settings summary")

        # T6/T15: expiry (restart the server with a 3-second life)
        srv.terminate(); srv.wait()
        srv = start_server(3000)
        laptop.fill("#paste", "expires-soon")
        laptop.click("#sendBtn")
        phone.wait_for_selector(".card", timeout=8000)
        gone = wait_for(lambda: phone.locator(".card").count() == 0 and laptop.locator(".card").count() == 0, timeout=8)
        check("T15 not copied: gone from both screens and server on time", gone is not None and server_items(K["token"])["items"] == [], f"{gone:.1f}s after seen" if gone else "")

        # Rotate the link: old link stops on the other device, new one works
        laptop.click("details.settings summary")
        laptop.click("#rotateBtn")
        laptop.click("#rotateBtn")
        laptop.wait_for_selector("#setup:not([hidden])", timeout=8000)
        rotated_link = laptop.inner_text("#newLink")
        phone_out = wait_for(lambda: not phone.locator("#start").is_hidden(), timeout=6)
        check("Rotate: the old link stops working on the phone", phone_out is not None)
        laptop.click("#goNew")
        laptop.wait_for_selector("#inbox:not([hidden])")
        check("Rotate: the new link opens the inbox", wait_for(lambda: "Connected" in laptop.inner_text("#status"), timeout=5) is not None and rotated_link != link)

        # T8: only our page and our server were contacted
        outside = sorted({h.split("/")[2] for h in hosts if not (h.startswith(SITE) or h.startswith(API) or h.startswith("data:"))})
        check("T8 no other website contacted", not outside, ",".join(outside))
        check("No security-policy errors in the page", not csp_errors, "; ".join(csp_errors[:3]))

        browser.close()
finally:
    srv.terminate()
    web.terminate()

# T11: hidden from search, not linked from home
page = open(os.path.join(REPO, "code", "index.html"), encoding="utf-8").read()
home = open(os.path.join(REPO, "index.html"), encoding="utf-8").read()
check("T11 page asks search engines not to index; home page has no link to it", 'content="noindex' in page and "/code" not in home)

passed = sum(1 for _, ok in results if ok)
print(f"\n{passed}/{len(results)} passed")
sys.exit(0 if passed == len(results) else 1)
