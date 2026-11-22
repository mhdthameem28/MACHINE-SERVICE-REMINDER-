import nodemailer from 'nodemailer';

export interface EmailSendResult {
  sent: boolean;
  recipientCount: number;
  error?: string;
}

export async function sendAlertEmail(
  recipients: string[],
  subject: string,
  textBody: string
): Promise<EmailSendResult> {
  const cleanRecipients = Array.from(
    new Set(recipients.map((e) => e.trim()).filter(Boolean))
  );
  if (cleanRecipients.length === 0) {
    return { sent: false, recipientCount: 0 };
  }

  const host = process.env.SMTP_HOST?.trim();
  const port = Number(process.env.SMTP_PORT || '587');
  const secure = process.env.SMTP_SECURE === 'true';
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.trim();
  const from = process.env.SMTP_FROM?.trim() || 'no-reply@production-tracker.local';

  if (!host) {
    return {
      sent: false,
      recipientCount: cleanRecipients.length,
    };
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port: Number.isFinite(port) ? port : 587,
      secure,
      auth: user && pass ? { user, pass } : undefined,
    });

    await transporter.sendMail({
      from,
      to: cleanRecipients.join(', '),
      subject,
      text: textBody,
    });

    return {
      sent: true,
      recipientCount: cleanRecipients.length,
    };
  } catch (err: unknown) {
    console.error('SMTP email dispatch failed:', err);
    return {
      sent: false,
      recipientCount: cleanRecipients.length,
      error: err instanceof Error ? err.message : 'Email delivery error',
    };
  }
}
