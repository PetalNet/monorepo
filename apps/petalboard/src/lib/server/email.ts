import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const FROM_EMAIL = process.env.FROM_EMAIL || SMTP_USER;
const APP_URL = process.env.APP_URL || "http://localhost:5173";

if (!SMTP_USER || !SMTP_PASS) {
  console.warn(
    "Email not configured: SMTP_USER and SMTP_PASS must be set in .env"
  );
}

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false, // Use STARTTLS
  auth: {
    user: SMTP_USER,
    pass: SMTP_PASS,
  },
});

export async function sendVerificationEmail(
  email: string,
  name: string,
  token: string
) {
  const verifyUrl = `${APP_URL}/verify/${token}`;

  const mailOptions = {
    from: `"PetalBoard" <${FROM_EMAIL}>`,
    to: email,
    subject: "Verify your PetalBoard account",
    html: `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; color: #2a1748; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #7c5dfa, #9b6bff); color: white; padding: 30px; border-radius: 12px 12px 0 0; text-align: center; }
            .content { background: white; padding: 30px; border: 1px solid #e5e5e5; border-top: none; border-radius: 0 0 12px 12px; }
            .button { display: inline-block; background: linear-gradient(135deg, #7c5dfa, #9b6bff); color: white; padding: 14px 32px; text-decoration: none; border-radius: 999px; font-weight: 600; margin: 20px 0; }
            .footer { text-align: center; margin-top: 20px; color: #666; font-size: 14px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1 style="margin: 0; font-size: 28px;">Welcome to PetalBoard!</h1>
            </div>
            <div class="content">
              <p>Hi ${name},</p>
              <p>Thanks for creating a PetalBoard account! Please verify your email address to start creating events.</p>
              <p style="text-align: center;">
                <a href="${verifyUrl}" class="button">Verify Email Address</a>
              </p>
              <p style="color: #666; font-size: 14px;">Or copy and paste this link into your browser:</p>
              <p style="color: #7c5dfa; word-break: break-all; font-size: 14px;">${verifyUrl}</p>
              <p style="margin-top: 30px; color: #666; font-size: 14px;">If you didn't create this account, you can safely ignore this email.</p>
            </div>
            <div class="footer">
              <p>PetalBoard - Effortless event signups</p>
            </div>
          </div>
        </body>
      </html>
    `,
    text: `Hi ${name},\n\nThanks for creating a PetalBoard account! Please verify your email address by clicking the link below:\n\n${verifyUrl}\n\nIf you didn't create this account, you can safely ignore this email.\n\nPetalBoard - Effortless event signups`,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Verification email sent to ${email}`);
  } catch (error) {
    console.error("Failed to send verification email:", error);
    throw new Error("Failed to send verification email");
  }
}
