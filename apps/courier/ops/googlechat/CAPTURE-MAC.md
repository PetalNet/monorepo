# Capture the bot's Google Chat session on a Mac

Use these steps only after Janet has installed and checked the prepared bot-only connector. Janet first checks whether the existing vault note is usable. No capture was taken during preparation.

Allow about one to two minutes once Chat is signed in in the private window. A normal Firefox window's login does not carry into private browsing. Signing in or completing a Google challenge can take longer.

1. In a normal browser window, open your existing private vault-drop bookmark. Under **Secret name**, select **custom (type below)**. Enter `parkerbott-gchat-curl` in **Custom name**. Leave **Secret value** empty for now.
2. In Firefox, choose **File > New Private Window** on the Mac. Open `https://chat.google.com/` and sign in as **petalcat27@gmail.com**. Check the Google account menu shows that exact address. Keep this as the only private window using this session.
3. Press **Command + Option + E** to open **Network**. With Network open, press **Command + L**, enter `https://chat.google.com/`, and press Return. Wait for Chat to load. This only loads Chat; do not send a message.
4. In Network, select the initial document request whose full **Request URL** is `https://chat.google.com/`. It can redirect afterward. Under **Headers > Request headers**, confirm a Cookie header exists. Control-click that request row and choose **Copy > Copy as cURL**. Choose the initial `/` request rather than a later `/u/0/` request to avoid duplicate path-specific COMPASS cookies.
5. Immediately close the private window with **Command + Shift + W**. Close any other private windows sharing this Google session too. Do not sign out through Google's account menu, because that invalidates the captured session.
6. Return to the normal-window vault-drop form. Paste into **Secret value** and click **Store in vault**. Wait for the success confirmation. Replace the clipboard by copying ordinary text afterward.

Keep the capture out of Terminal, chat, text files, and screenshots. Never run the copied command. If the form reports the value exceeds its 8,192-character limit, or the initial document has no Cookie header, stop and tell Janet the error without sharing the capture. Do not truncate it or substitute a HAR export. The importer also rejects ambiguous duplicate cookies or captures missing the newer cookie; Janet handles that without exposing the values.

The vault-drop origin was resolved from `/home/docker/secret-drop/server.mjs` and its user service configuration on dot14. No private URL is included in these artifacts. Use the existing private bookmark or have Janet resolve the configured host internally.

[Firefox Network shortcut](https://firefox-source-docs.mozilla.org/devtools-user/network_monitor/index.html), [Copy as cURL](https://firefox-source-docs.mozilla.org/devtools-user/network_monitor/request_list/index.html), [private-window cookies](https://support.mozilla.org/en-US/kb/private-browsing-use-firefox-without-history).
