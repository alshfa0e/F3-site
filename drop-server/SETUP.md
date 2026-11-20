# Drop v2 — daily rooms

Drop moves code between two devices. Open it, type a 4-character code on the other device, and you are paired for the day.
Code is locked on the device before it leaves. The server only holds locked text, in memory, and deletes it on **Copy & delete** or after 5 minutes.

## Use it
1. Open `https://f3.sa/code/` on the first device (iPhone or PC). It shows a code, for example `K7QH`.
2. On the other device, open `https://f3.sa/code/` and type `K7QH` under **Have a code from another device?** → **Join**. Or tap **Share link** and open the link on the other device.
3. Both show **Paired with …**. Paste, **Send**, then **Copy & delete** on the other side.
4. Big paste? Copy it, then tap **Paste & send**. It sends straight from the clipboard without loading the text into the box (much faster on iPhone).
5. Files: tap **Attach file** (or drag files onto the box on a computer). The other side taps **Save & delete**. "Save again" works on that device until the 5 minutes are up.

Rules:
- The code works for **10 minutes, once**. Need another? Tap **New code**.
- A room holds **2 devices**. If a new device joins with a new code, it replaces the paired one.
- The room ends after **24 hours**. The next day you get a new code.
- **Not you?** If *Paired with …* shows a device that is not yours, tap **Not me – end room** (twice). The room is gone for both.
- Friends can use it the same way. Each gets their own room and cannot see yours.

## Stats (counts only)
1. Right after this version goes live, open `https://f3.sa/code/#stats` and tap **Make my stats link**. This works once, for whoever is first.
2. Save the link it shows (it ends in `#s=…`) as a bookmark. It is the only way to open stats.
3. Stats show, per day for 30 days: visits by device type, rooms, joins, wrong codes, sent, copied, expired, ended, blocked. No addresses and no content are kept.

## Limits that stop abuse
- 10 new rooms per network per day. 200 rooms open at once.
- Wrong codes: 10 per network per hour, 30 from everyone per hour. After that, joining pauses for up to an hour.
- Up to 10 MB per item after packing (code usually packs 5 to 10 times smaller; photos, PDFs and zips do not). 30 items and 40 MB per room; 100 MB on the server in total.

## Server
- Already running on Oracle (Riyadh) at `api2.f3.sa`. It updates itself from GitHub `main` within 15 minutes of a merged pull request.
- `https://api2.f3.sa/health` shows `{"ok":true,"v":2,...}` and `update`: the time and result of the last update check (`updated`, `up-to-date`, `fetch-failed` or `check-failed`). It should never be more than about 15 minutes old.
- On disk it keeps only `stats.json` (counts) and `stats-auth` (a hash of the stats link). Rooms and code live in memory only.
- Restarts (updates, or 03:30 after security updates) end all rooms. Open the page again for a new code.

## Rebuild from scratch (only if the server is lost)
1. Oracle → **Compute** → **Instances** → **Create instance**, name `drop`, image Canonical Ubuntu 24.04, shape `VM.Standard.A1.Flex` 1 OCPU, network `drop-vcn` public subnet with a public IPv4 address, **No SSH keys**.
2. **Advanced options → Management → Paste cloud-init script:** paste `drop-server/cloud-init.yaml` exactly as it is.
3. When it is *Running*, put the new public IP in the DNet **A** record for `api2`.
4. Wait about 10 minutes and check `https://api2.f3.sa/health`. Then claim stats again (step above).

## Good to know
- **Clipboard:** after pasting, copy any harmless word so the code does not stay in your clipboard.
- **This device remembers the room for the day.** On a shared computer, tap **Room → End room now** when done.
- **Public code:** the page and server code are public on GitHub. Safety comes from the keys on your devices, not from hiding the code.
