# Email setup

PetalBoard sends email through [Resend](https://resend.com) for guest RSVP edit links.

1. Verify your sending domain in the Resend dashboard.
2. Create an API key with sending access.
3. Set these environment variables:

```env
RESEND_API_KEY="re_..."
EMAIL_FROM="PetalBoard <rsvp@petalcat.dev>"  # optional; this is the default
APP_URL="https://your_app_url.com"          # base URL for links in emails
```

`EMAIL_FROM` must use a domain verified in Resend. When Resend rejects a send, the server logs the
HTTP status. It never logs the key.

## Guest edit links

Guests RSVP with an email address and no password. The browser that RSVPs gets a cookie that lets
it edit the RSVP for 400 days. Any other browser uses **Edit my RSVP** on the event page, which
emails a link that works once, for 1 hour. Each email address gets at most 3 links per 15 minutes,
and each IP address at most 20.
