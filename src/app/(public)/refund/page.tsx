import type { Metadata } from "next";
import Link from "next/link";
import LegalPage, { Section, List, SUPPORT_EMAIL } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Refund & Cancellation Policy | Sowsi Cloud",
  description: "When Sowsi Cloud refunds payments, how to cancel autopay, and how long refunds take.",
};

const link = "text-blue-400 hover:underline";

export default function RefundPage() {
  return (
    <LegalPage
      title="Refund & Cancellation Policy"
      current="/refund"
      intro={
        <p>
          This policy explains when you can get your money back and how cancelling works. It&apos;s part of our{" "}
          <Link href="/terms" className={link}>Terms of Service</Link>.
        </p>
      }
    >
      <Section title="1. Full refunds">
        <p>You get a full refund in these cases:</p>
        <List>
          <li>
            <strong className="text-white">We couldn&apos;t set up your server.</strong> If setup fails after you pay,
            we refund you automatically — you don&apos;t need to ask — and cancel the autopay.
          </li>
          <li>
            <strong className="text-white">You were charged twice or charged the wrong amount</strong> because of an
            error on our side or Razorpay&apos;s.
          </li>
          <li>
            <strong className="text-white">You were charged after cancelling autopay</strong> or after deleting the
            server.
          </li>
        </List>
      </Section>

      <Section title="2. Cancelling autopay">
        <p>
          You can cancel autopay any time from <strong className="text-white">Dashboard → My Servers</strong>. No
          further payments are taken, and your server keeps running until the end of the period you&apos;ve already
          paid for. After that it&apos;s suspended, and deleted if you don&apos;t restart autopay — see{" "}
          <Link href="/terms#non-payment" className={link}>Terms, section 5</Link>.
        </p>
      </Section>

      <Section title="3. What isn't refunded">
        <List>
          <li>
            The unused part of a period that&apos;s already been paid for, once your server has been delivered — for
            monthly plans and for prepaid 1-year and 2-year terms. Cancelling stops future charges instead.
          </li>
          <li>Servers suspended or deleted for non-payment.</li>
          <li>
            Servers suspended or removed for breaking our acceptable use rules (
            <Link href="/terms" className={link}>Terms, section 7</Link>).
          </li>
          <li>GST that has already been paid to the government on an invoice, where the law doesn&apos;t allow it to be reversed.</li>
        </List>
      </Section>

      <Section title="4. How to request a refund">
        <p>
          Email <a href={`mailto:${SUPPORT_EMAIL}`} className={link}>{SUPPORT_EMAIL}</a> from your account email
          within 30 days of the charge, with the invoice number or Razorpay payment ID and a short description. We
          reply within 2 business days.
        </p>
      </Section>

      <Section title="5. How long refunds take">
        <p>
          Approved refunds go back to the original payment method (card, UPI or bank account) through Razorpay. They
          usually reach you within 5–7 business days, depending on your bank.
        </p>
      </Section>
    </LegalPage>
  );
}
