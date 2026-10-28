import type { Metadata } from "next";
import Link from "next/link";
import LegalPage, { Section, List, SUPPORT_EMAIL } from "@/components/legal/LegalPage";
import { DELETE_AFTER_SUSPENDED_DAYS } from "@/lib/billing/constants";

export const metadata: Metadata = {
  title: "Terms of Service | Sowsi Cloud",
  description: "The terms for using Sowsi Cloud hosting: accounts, autopay billing, failed payments, acceptable use and liability.",
};

const link = "text-blue-400 hover:underline";

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      current="/terms"
      intro={
        <p>
          These terms are an agreement between you and Sowsi Cloud Services (&ldquo;Sowsi Cloud&rdquo;,
          &ldquo;we&rdquo;) for using sowsicloud.com and our hosting services. By creating an account or placing an
          order, you agree to them. Please also read our{" "}
          <Link href="/privacy" className={link}>Privacy Policy</Link> and{" "}
          <Link href="/refund" className={link}>Refund Policy</Link>.
        </p>
      }
    >
      <Section title="1. Your account">
        <List>
          <li>You must be at least 18 and give accurate details, including a working email address.</li>
          <li>You&apos;re responsible for keeping your login secure and for everything done through your account.</li>
          <li>Tell us straight away at {SUPPORT_EMAIL} if you think your account has been misused.</li>
        </List>
      </Section>

      <Section title="2. The service">
        <p>
          We provide virtual servers (VPS) and related hosting with the resources listed for your plan at the time of
          purchase. You get full (root) access to your server, which means you&apos;re responsible for what runs on
          it — including its software, updates, security and the content you host.
        </p>
        <p>
          Our platform may automatically adjust your server&apos;s resources (for example, expanding disk space) to
          keep it running smoothly, within the limits of your plan.
        </p>
      </Section>

      <Section title="3. Prices, GST and fees">
        <p>
          Prices are in Indian Rupees. GST at the applicable rate and a payment processing fee are added and shown
          before you pay. You&apos;ll receive a GST invoice for every payment.
        </p>
      </Section>

      <Section id="autopay" title="4. Autopay and renewals">
        <List>
          <li>
            Every server is billed through a Razorpay autopay mandate, which you approve at checkout. Your bank or
            Razorpay may send you a notice before each charge.
          </li>
          <li>
            <strong className="text-white">Monthly plans</strong> are charged at checkout and then every month on the
            same date.
          </li>
          <li>
            <strong className="text-white">1-year and 2-year plans</strong> are paid upfront for the whole term at
            the price shown at checkout. When the term ends, autopay continues <em>monthly</em> at the renewal price
            shown at checkout, unless you cancel before then.
          </li>
          <li>
            You can cancel autopay any time from your dashboard. Nothing more is charged, and your server keeps
            running until the end of the period you&apos;ve already paid for.
          </li>
        </List>
      </Section>

      <Section id="non-payment" title="5. Failed payments, suspension and deletion">
        <List>
          <li>
            If a renewal payment fails, Razorpay retries it automatically over the next few days and we email you so
            you can top up or switch payment method.
          </li>
          <li>
            If the payment still can&apos;t be collected — or your paid period ends with autopay off — your server is{" "}
            <strong className="text-white">suspended</strong>: it&apos;s shut down and you can&apos;t access it, but
            your data is kept.
          </li>
          <li>
            To restore it, restart autopay from your dashboard. Once the payment goes through, the server starts again
            automatically.
          </li>
          <li>
            If no payment is received within{" "}
            <strong className="text-white">{DELETE_AFTER_SUSPENDED_DAYS} days of suspension</strong>, the server, all
            of its data and its IP address are{" "}
            <strong className="text-white">permanently deleted</strong> and can&apos;t be recovered. We email you
            when the server is suspended and again when it&apos;s deleted.
          </li>
        </List>
      </Section>

      <Section title="6. Cancelling and deleting a server">
        <p>
          When you delete a server from your dashboard, its autopay is cancelled and the server, its data and its IP
          address are removed immediately and permanently. Refunds are covered by our{" "}
          <Link href="/refund" className={link}>Refund Policy</Link>.
        </p>
      </Section>

      <Section title="7. Acceptable use">
        <p>You must not use Sowsi Cloud to:</p>
        <List>
          <li>break any law, or host content that is illegal in India or Germany;</li>
          <li>send spam, run phishing sites, or distribute malware;</li>
          <li>attack, scan or disrupt other networks or systems, including DDoS attacks;</li>
          <li>infringe anyone else&apos;s copyright, trademarks or privacy;</li>
          <li>mine cryptocurrency, or use resources in a way that harms other customers;</li>
          <li>try to access other customers&apos; servers or our internal systems.</li>
        </List>
        <p>
          We may suspend or remove a server that breaks these rules, without a refund. Where we can, we&apos;ll warn
          you first and give you a chance to fix the problem.
        </p>
      </Section>

      <Section title="8. Your data and backups">
        <p>
          You own the data on your server. We work hard to keep it safe, but hardware and software can fail, so
          please keep your own up-to-date backups of anything important. Where a plan includes backups, they are
          provided on a best-effort basis and don&apos;t replace your own.
        </p>
      </Section>

      <Section title="9. Availability and support">
        <p>
          We aim for 99.9% monthly availability, not counting scheduled maintenance (which we&apos;ll announce in
          advance where possible) or problems outside our control. Support is available by ticket from your dashboard
          or at {SUPPORT_EMAIL}.
        </p>
      </Section>

      <Section title="10. Changes to prices and these terms">
        <p>
          We&apos;ll give you at least 30 days&apos; notice by email before a price change affects your renewals. An
          autopay you&apos;ve already approved won&apos;t charge more than you authorised. We may update these terms;
          if a change is significant, we&apos;ll let you know in advance, and continuing to use the service after
          that means you accept the new terms.
        </p>
      </Section>

      <Section title="11. Liability">
        <p>
          The service is provided &ldquo;as is&rdquo;. To the extent the law allows, we aren&apos;t liable for
          indirect or consequential losses such as lost profits, revenue or data, and our total liability for any
          claim is limited to the amount you paid us for the affected service in the 3 months before the claim.
        </p>
      </Section>

      <Section title="12. Ending the agreement">
        <p>
          You can stop using Sowsi Cloud at any time by deleting your servers and asking us to close your account. We
          may close accounts that seriously or repeatedly break these terms.
        </p>
      </Section>

      <Section title="13. Governing law">
        <p>These terms are governed by the laws of India, and disputes are subject to the jurisdiction of Indian courts.</p>
      </Section>
    </LegalPage>
  );
}
