import { env } from "$env/dynamic/private";

const RESEND_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "PetalBoard <rsvp@petalcat.dev>";

interface Email {
	to: string;
	subject: string;
	html: string;
	text: string;
}

async function sendEmail({ to, subject, html, text }: Email) {
	if (!env.RESEND_API_KEY) {
		throw new Error("RESEND_API_KEY is not set");
	}

	const response = await fetch(RESEND_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ from: env.EMAIL_FROM || DEFAULT_FROM, to, subject, html, text }),
	});

	if (!response.ok) {
		throw new Error(`Resend rejected the email with status ${response.status}`);
	}
}

function appUrl() {
	return env.APP_URL || "http://localhost:5173";
}

function escapeHtml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function layout(heading: string, body: string) {
	return `<!DOCTYPE html>
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
        <h1 style="margin: 0; font-size: 28px;">${heading}</h1>
      </div>
      <div class="content">
${body}
      </div>
      <div class="footer">
        <p>PetalBoard - Effortless event signups</p>
      </div>
    </div>
  </body>
</html>`;
}

function linkBlock(label: string, url: string) {
	return `        <p style="text-align: center;">
          <a href="${url}" class="button">${label}</a>
        </p>
        <p style="color: #666; font-size: 14px;">Or copy and paste this link into your browser:</p>
        <p style="color: #7c5dfa; word-break: break-all; font-size: 14px;">${url}</p>`;
}

export type RsvpEmailKind = "confirmation" | "already" | "requested";

const RSVP_COPY: Record<RsvpEmailKind, { subject: (title: string) => string; intro: string }> = {
	confirmation: {
		subject: (title) => `You're on the list for ${title}`,
		intro: "Your RSVP for {title} is in. If your plans change, you can edit it here:",
	},
	already: {
		subject: (title) => `You're already on the list for ${title}`,
		intro:
			"Someone tried to RSVP to {title} with this email, but you're already on the list. To change your RSVP, use this link:",
	},
	requested: {
		subject: (title) => `Edit your RSVP for ${title}`,
		intro: "Here's the link you asked for to edit your RSVP for {title}:",
	},
};

// Guests type the address, so the body carries nothing else a guest typed.
export async function sendRsvpEmail(
	kind: RsvpEmailKind,
	email: string,
	event: { title: string; publicCode: string },
	token: string,
) {
	const copy = RSVP_COPY[kind];
	const editUrl = `${appUrl()}/event/${event.publicCode}/edit?token=${token}`;
	const expiry =
		'This link works for 1 hour. After that, use "Edit my RSVP" on the event page to get a fresh one.';
	const ignore = "If you didn't ask for this, you can ignore this email.";
	const html = layout(
		escapeHtml(event.title),
		`        <p>Hi,</p>
        <p>${copy.intro.replace("{title}", `<strong>${escapeHtml(event.title)}</strong>`)}</p>
${linkBlock("Edit my RSVP", editUrl)}
        <p style="color: #666; font-size: 14px;">${escapeHtml(expiry)}</p>
        <p style="margin-top: 30px; color: #666; font-size: 14px;">${escapeHtml(ignore)}</p>`,
	);

	await sendEmail({
		to: email,
		subject: copy.subject(event.title),
		html,
		text: `Hi,\n\n${copy.intro.replace("{title}", event.title)}\n\n${editUrl}\n\n${expiry}\n\n${ignore}\n\nPetalBoard - Effortless event signups`,
	});
}
