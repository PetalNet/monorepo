# Email Configuration Guide

PetalBoard uses Gmail SMTP to send email verification messages. Follow these steps to configure your Gmail account.

## Step 1: Generate a Gmail App Password

1. Go to your [Google Account Settings](https://myaccount.google.com/)
2. Navigate to **Security** → **2-Step Verification** (you must have 2FA enabled)
3. Scroll down to **App passwords**
4. Click **Select app** → Choose "Mail"
5. Click **Select device** → Choose "Other" and enter "PetalBoard"
6. Click **Generate**
7. Copy the 16-character app password (it will look like `xxxx xxxx xxxx xxxx`)

## Step 2: Update Your .env File

Open the `.env` file in the project root and update these values:

```env
# Email configuration (Gmail SMTP)
SMTP_HOST="smtp.gmail.com"
SMTP_PORT="587"
SMTP_USER="your-email@gmail.com"          # Replace with your Gmail address
SMTP_PASS="your-app-password-here"        # Replace with the 16-char app password (no spaces)
FROM_EMAIL="your-email@gmail.com"         # Replace with your Gmail address
APP_URL="http://localhost:5173"           # Change for production
```

**Important Notes:**

- Use your Gmail address for `SMTP_USER` and `FROM_EMAIL`
- Use the app password (not your regular Gmail password) for `SMTP_PASS`
- Remove spaces from the app password
- For production, update `APP_URL` to your production domain

## Step 3: Test Email Verification

1. Start the dev server: `pnpm dev`
2. Visit http://localhost:5173/register
3. Create a new account with your information
4. Check your email inbox for the verification link
5. Click the link to verify your account
6. You'll be redirected and logged in automatically

## Troubleshooting

### "Failed to send verification email"

- Double-check your `SMTP_USER` and `SMTP_PASS` in `.env`
- Make sure 2FA is enabled on your Google account
- Verify the app password was copied correctly (no spaces)
- Check that "Less secure app access" is NOT enabled (use app passwords instead)

### Email not received

- Check your spam/junk folder
- Verify the email address is correct
- Check server logs for errors

### "Invalid or expired verification link"

- Links are single-use only
- Register again if needed
- Contact support if the issue persists

## Production Considerations

For production deployments:

1. **Use environment variables** from your hosting provider
2. **Update APP_URL** to your production domain
3. **Consider using a dedicated email service** like SendGrid, AWS SES, or Postmark for better deliverability
4. **Add rate limiting** on registration to prevent abuse
5. **Set up email templates** with your branding

## Alternative Email Providers

While this guide uses Gmail, you can configure other SMTP providers by updating these variables:

- **SendGrid**: `smtp.sendgrid.net:587`
- **AWS SES**: `email-smtp.us-east-1.amazonaws.com:587`
- **Mailgun**: `smtp.mailgun.org:587`
- **Postmark**: `smtp.postmarkapp.com:587`

Adjust `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, and `SMTP_PASS` accordingly.
