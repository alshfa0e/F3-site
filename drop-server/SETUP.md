# Drop — one-time setup (about 30 minutes)

Drop is a private inbox for code between your own devices.
Your code is locked on your device before it leaves. The server only ever holds locked text, keeps it in memory, and deletes it when you tap **Copy & delete** or after 5 minutes.

## 0. Before you start
Merge the pull request. The page goes live at `https://f3.sa/code/` within a few minutes.

## 1. Make your link (on your phone)
1. Open `https://f3.sa/code/`.
2. Tap **First time? Create your link**, then **Create my link**.
3. Tap **Copy link**, open it, and save it as a bookmark. This link is your key. Do not send it in chats or email.
4. Tap **Copy server setup script**. Keep it for step 2.7 (it holds only the server code, which cannot open anything).

## 2. Create the server on Oracle (easier on a computer)
1. Sign up at `oracle.com/cloud/free`.
2. **Home Region:** choose Saudi Arabia — Jeddah or Riyadh. It cannot be changed later. If neither is offered, stop and ask.
3. Menu → **Compute** → **Instances** → **Create instance**. Name: `drop`.
4. **Image:** Canonical Ubuntu 24.04.
5. **Shape:** the one marked *Always Free-eligible* — `VM.Standard.E2.1.Micro`. (If it is not available, `VM.Standard.A1.Flex` with 1 OCPU is also Always Free.)
6. **Networking:** keep "create new virtual cloud network" and "assign a public IPv4 address". **SSH keys:** choose **No SSH keys**.
7. **Advanced options → Management → Paste cloud-init script:** paste the setup script from step 1.4.
8. Tap **Create**. When it shows *Running*, copy the **Public IP address**.
9. Open the web ports: instance page → **Subnet** → **Security** (security list) → **Add Ingress Rules**:
   - Source CIDR `0.0.0.0/0`, protocol TCP, destination port `80`
   - Source CIDR `0.0.0.0/0`, protocol TCP, destination port `443`

## 3. Point api.f3.sa at the server
Where you manage the f3.sa domain, add one record: type **A**, name **api**, value **the public IP**. Do this right after step 2.8.

## 4. Check
1. Wait about 10 minutes, then open `https://api.f3.sa/health`. It should show `{"ok":true,"ready":true}`.
2. Not working after 30 minutes? Oracle console → the instance → **Reboot**.

## 5. Use it
- **Phone:** open your bookmark.
- **Laptop:** open `https://f3.sa/code/`, type your key once (the 25 characters after `#`), tap **Open**, then bookmark the page.

## 6. Safety net
- Oracle → **Billing** → **Budgets** → create a budget of 1 USD with an email alert.
- If Oracle emails that the instance is "idle", ask before doing anything. The usual fix is upgrading the account to Pay As You Go, which stays free inside the Always Free limits (not yet confirmed for this account).

## Good to know
- **One link, always.** The link is the key. If it may have been seen, open **Settings → Make a new link**; the old one stops at once and the other device needs the new link.
- **Lost the link on every device?** Make a new link on a fresh page, then rebuild the server (terminate the old instance, repeat step 2 with the new setup script).
- **Clipboard:** after pasting, copy any harmless word so the code does not stay in your clipboard.
- **History:** your browser history and bookmarks hold the link, like a saved password.
- **Restarts:** the server may restart at 03:30 after security updates. Anything in the inbox at that moment is gone (by design).
- **Updates:** the server checks GitHub `main` every 15 minutes and updates itself. Changes come as pull requests that you approve.
- **Public code:** the page and server code are public on GitHub. That is fine: safety comes from your key, not from hiding the code.
