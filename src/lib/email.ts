import { Resend } from "resend";

const FROM = process.env.EMAIL_FROM || "noreply@sowsicloud.com";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://sowsicloud.com";

// Resend's constructor throws on a missing/empty key. Building it lazily
// (only when an email actually needs to go out) keeps a missing key from
// crashing `next build`'s page-data collection for every route that
// imports this module, and from taking down unrelated requests at runtime.
let resend: Resend | null = null;
function getResendClient(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}

export async function sendWelcomeEmail(to: string, name: string) {
  const client = getResendClient();
  if (!client) return console.warn("[email] RESEND_API_KEY not set — skipping welcome email to", to);
  await client.emails.send({
    from: FROM,
    to,
    subject: "Welcome to Sowsi Cloud Services!",
    html: `
      <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#0A0F1E;color:#fff;padding:40px;border-radius:12px;">
        <h1 style="color:#1B4FE8;font-size:28px;margin-bottom:8px;">Welcome to Sowsi Cloud!</h1>
        <p style="color:#9CA3AF;font-size:16px;">Hi ${name},</p>
        <p style="color:#D1D5DB;">Thank you for choosing Sowsi Cloud Services. Your account has been created successfully.</p>
        <p style="color:#D1D5DB;">You can now log in and choose a hosting plan that suits your needs.</p>
        <a href="${APP_URL}/dashboard" style="display:inline-block;background:#1B4FE8;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;margin-top:16px;font-weight:600;">Go to Dashboard</a>
        <p style="color:#6B7280;font-size:14px;margin-top:32px;">Need help? Contact us at support@sowsicloud.com</p>
        <p style="color:#4B5563;font-size:12px;">© 2024 Sowsi Cloud Services, Hyderabad, India</p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail(
  to: string,
  name: string,
  token: string
) {
  const client = getResendClient();
  if (!client) return console.warn("[email] RESEND_API_KEY not set — skipping password reset email to", to);
  const resetUrl = `${APP_URL}/reset-password?token=${token}`;
  await client.emails.send({
    from: FROM,
    to,
    subject: "Reset Your Sowsi Cloud Password",
    html: `
      <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#0A0F1E;color:#fff;padding:40px;border-radius:12px;">
        <h1 style="color:#1B4FE8;font-size:24px;">Password Reset Request</h1>
        <p style="color:#D1D5DB;">Hi ${name}, we received a request to reset your password.</p>
        <a href="${resetUrl}" style="display:inline-block;background:#1B4FE8;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;margin-top:16px;font-weight:600;">Reset Password</a>
        <p style="color:#9CA3AF;font-size:14px;margin-top:16px;">This link expires in 1 hour. If you didn't request this, ignore this email.</p>
        <p style="color:#4B5563;font-size:12px;">© 2024 Sowsi Cloud Services</p>
      </div>
    `,
  });
}

export async function sendCredentialsEmail(
  to: string,
  name: string,
  server: {
    planName: string;
    hostname: string;
    serverIp: string;
    sshUsername: string;
    sshPassword: string;
    panelUrl?: string;
  }
) {
  const client = getResendClient();
  if (!client) return console.warn("[email] RESEND_API_KEY not set — skipping credentials email to", to);
  await client.emails.send({
    from: FROM,
    to,
    subject: `Your ${server.planName} server is ready`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#0A0F1E;color:#fff;padding:40px;border-radius:12px;">
        <h1 style="color:#1B4FE8;font-size:24px;">Your server is ready!</h1>
        <p style="color:#D1D5DB;">Hi ${name}, your <strong>${server.planName}</strong> server has been provisioned and is now active.</p>
        <div style="background:#111827;border-radius:8px;padding:24px;margin:24px 0;">
          <p style="color:#9CA3AF;margin:0 0 4px;">Hostname</p>
          <p style="color:#fff;font-family:monospace;margin:0 0 16px;">${server.hostname}</p>
          <p style="color:#9CA3AF;margin:0 0 4px;">Server IP</p>
          <p style="color:#fff;font-family:monospace;margin:0 0 16px;">${server.serverIp}</p>
          <p style="color:#9CA3AF;margin:0 0 4px;">SSH Username</p>
          <p style="color:#fff;font-family:monospace;margin:0 0 16px;">${server.sshUsername}</p>
          <p style="color:#9CA3AF;margin:0 0 4px;">SSH Password</p>
          <p style="color:#fff;font-family:monospace;margin:0;">${server.sshPassword}</p>
        </div>
        ${server.panelUrl ? `<p style="color:#D1D5DB;">Control panel: <a href="${server.panelUrl}" style="color:#60A5FA;">${server.panelUrl}</a></p>` : ""}
        <p style="color:#F87171;font-size:13px;">For security, please log in and change your password immediately.</p>
        <a href="${APP_URL}/dashboard/services" style="display:inline-block;background:#1B4FE8;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;margin-top:16px;font-weight:600;">View in Dashboard</a>
        <p style="color:#4B5563;font-size:12px;margin-top:32px;">© 2024 Sowsi Cloud Services, Hyderabad, India</p>
      </div>
    `,
  });
}

export async function sendInvoiceEmail(
  to: string,
  name: string,
  invoiceNumber: string,
  planName: string,
  amount: number,
  gstAmount: number
) {
  const client = getResendClient();
  if (!client) return console.warn("[email] RESEND_API_KEY not set — skipping invoice email to", to);
  const total = amount + gstAmount;
  await client.emails.send({
    from: FROM,
    to,
    subject: `Invoice #${invoiceNumber} - Sowsi Cloud Services`,
    html: `
      <div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;background:#0A0F1E;color:#fff;padding:40px;border-radius:12px;">
        <h1 style="color:#1B4FE8;font-size:24px;">Payment Confirmed</h1>
        <p style="color:#D1D5DB;">Hi ${name}, your payment has been processed successfully.</p>
        <div style="background:#111827;border-radius:8px;padding:24px;margin:24px 0;">
          <p style="color:#9CA3AF;margin:0 0 8px;">Invoice Number</p>
          <p style="color:#fff;font-weight:600;font-size:18px;margin:0 0 16px;">#${invoiceNumber}</p>
          <p style="color:#9CA3AF;margin:0 0 4px;">Plan</p>
          <p style="color:#fff;margin:0 0 16px;">${planName}</p>
          <hr style="border-color:#1F2937;margin:16px 0;" />
          <div style="display:flex;justify-content:space-between;">
            <span style="color:#9CA3AF;">Subtotal</span>
            <span style="color:#fff;">₹${amount.toLocaleString("en-IN")}</span>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:8px;">
            <span style="color:#9CA3AF;">GST (18%)</span>
            <span style="color:#fff;">₹${gstAmount.toLocaleString("en-IN")}</span>
          </div>
          <hr style="border-color:#1F2937;margin:16px 0;" />
          <div style="display:flex;justify-content:space-between;">
            <span style="color:#fff;font-weight:600;">Total</span>
            <span style="color:#1B4FE8;font-weight:700;font-size:18px;">₹${total.toLocaleString("en-IN")}</span>
          </div>
        </div>
        <a href="${APP_URL}/dashboard/billing" style="display:inline-block;background:#1B4FE8;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">View Invoice</a>
        <p style="color:#4B5563;font-size:12px;margin-top:32px;">© 2024 Sowsi Cloud Services, Hyderabad, India. GSTIN: XXXXXXXXXXXX</p>
      </div>
    `,
  });
}
