import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/types";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) return apiError("Unauthorized", 401);

  const { id } = await params;

  const payment = await prisma.payment.findFirst({
    where: { id, userId: session.userId, status: "SUCCESS" },
    include: {
      user: { select: { name: true, email: true, phone: true, company: true } },
      service: { include: { plan: true } },
    },
  });

  if (!payment) return apiError("Invoice not found", 404);

  const total = payment.amount + payment.gstAmount;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invoice #${payment.invoiceNumber}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Inter, Arial, sans-serif; background: #fff; color: #111; padding: 40px; max-width: 800px; margin: 0 auto; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px; border-bottom: 2px solid #1B4FE8; padding-bottom: 24px; }
  .logo { font-size: 22px; font-weight: 900; color: #1B4FE8; }
  .logo-sub { font-size: 12px; color: #888; }
  .invoice-title { font-size: 28px; font-weight: 700; color: #111; text-align: right; }
  .invoice-meta { font-size: 13px; color: #666; text-align: right; line-height: 1.7; }
  .section { margin-bottom: 32px; }
  .section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: #888; margin-bottom: 8px; }
  .info { font-size: 14px; line-height: 1.7; color: #333; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th { text-align: left; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; color: #888; border-bottom: 1px solid #eee; padding: 8px 12px; }
  td { padding: 12px; font-size: 14px; color: #333; border-bottom: 1px solid #f5f5f5; }
  .totals { margin-left: auto; width: 280px; }
  .totals td { border: none; padding: 6px 12px; }
  .total-row td { font-weight: 700; font-size: 16px; color: #1B4FE8; border-top: 2px solid #1B4FE8; padding-top: 12px; }
  .footer { margin-top: 48px; font-size: 12px; color: #aaa; border-top: 1px solid #eee; padding-top: 16px; text-align: center; }
  .badge { display: inline-block; background: #d1fae5; color: #065f46; font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 100px; }
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="logo">Sowsi Cloud Services</div>
    <div class="logo-sub">sowsicloud.com</div>
    <div class="logo-sub" style="margin-top:4px">Hyderabad, Telangana, India</div>
    <div class="logo-sub">GSTIN: XXXXXXXXXXXX</div>
  </div>
  <div>
    <div class="invoice-title">TAX INVOICE</div>
    <div class="invoice-meta">
      Invoice #${payment.invoiceNumber}<br>
      Date: ${new Date(payment.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}<br>
      <span class="badge">PAID</span>
    </div>
  </div>
</div>

<div class="section">
  <div class="section-title">Bill To</div>
  <div class="info">
    <strong>${payment.user.name}</strong><br>
    ${payment.user.email}<br>
    ${payment.user.phone}<br>
    ${payment.user.company || ""}
  </div>
</div>

<table>
  <thead>
    <tr>
      <th>Description</th>
      <th>Period</th>
      <th style="text-align:right">Amount</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>${payment.service?.plan?.name || "Hosting Service"}</td>
      <td>1 Month</td>
      <td style="text-align:right">₹${payment.amount.toLocaleString("en-IN")}</td>
    </tr>
  </tbody>
</table>

<table class="totals">
  <tr><td>Subtotal</td><td style="text-align:right">₹${payment.amount.toLocaleString("en-IN")}</td></tr>
  <tr><td>GST (18%)</td><td style="text-align:right">₹${payment.gstAmount.toLocaleString("en-IN")}</td></tr>
  <tr class="total-row"><td>Total</td><td style="text-align:right">₹${total.toLocaleString("en-IN")}</td></tr>
</table>

<div class="footer">
  This is a computer generated invoice. No signature required.<br>
  Sowsi Cloud Services · Hyderabad, Telangana 500001 · support@sowsicloud.com<br>
  GSTIN: XXXXXXXXXXXX
</div>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html",
      "Content-Disposition": `inline; filename="invoice-${payment.invoiceNumber}.html"`,
    },
  });
}
