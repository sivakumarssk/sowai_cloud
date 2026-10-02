import Razorpay from "razorpay";
import crypto from "crypto";

// Razorpay's constructor throws if key_id is missing/empty. Building it
// lazily (only when a route actually calls razorpay.orders.create) keeps a
// missing key from crashing `next build`'s page-data collection for every
// route that imports this module.
let razorpayClient: Razorpay | null = null;
function getRazorpayClient(): Razorpay {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error("Razorpay is not configured — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.");
  }
  if (!razorpayClient) {
    razorpayClient = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return razorpayClient;
}

export const razorpay = new Proxy({} as Razorpay, {
  get(_target, prop, receiver) {
    return Reflect.get(getRazorpayClient(), prop, receiver);
  },
});

export function verifyRazorpaySignature(
  orderId: string,
  paymentId: string,
  signature: string
): boolean {
  const body = orderId + "|" + paymentId;
  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!)
    .update(body)
    .digest("hex");
  return expectedSignature === signature;
}

/** Verifies the X-Razorpay-Signature header on incoming webhook payloads. */
export function verifyRazorpayWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  const expectedSignature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return expectedSignature === signature;
}

export function generateInvoiceNumber(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const random = Math.floor(Math.random() * 100000)
    .toString()
    .padStart(5, "0");
  return `INV-${year}${month}-${random}`;
}

export { calculateGST } from "@/lib/pricing";
