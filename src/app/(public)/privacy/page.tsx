import type { Metadata } from "next";
import Link from "next/link";
import LegalPage, { Section, List, SUPPORT_EMAIL } from "@/components/legal/LegalPage";

export const metadata: Metadata = {
  title: "Privacy Policy | Sowsi Cloud",
  description: "What personal data Sowsi Cloud collects, why, who we share it with, and your rights.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      current="/privacy"
      intro={
        <p>
          This policy explains what personal data Sowsi Cloud Services (&ldquo;Sowsi Cloud&rdquo;, &ldquo;we&rdquo;)
          collects when you use sowsicloud.com and our hosting services, why we collect it, and what you can do about
          it. We only collect what we need to run your account, bill you and keep the service secure.
        </p>
      }
    >
      <Section title="1. Data we collect">
        <List>
          <li>
            <strong className="text-white">Account details</strong> — your name, email address, phone number and
            (optionally) company name. Passwords are stored only as a one-way hash; we can never see them.
          </li>
          <li>
            <strong className="text-white">Google sign-in</strong> — if you sign in with Google, we receive your name,
            email address and whether Google has verified it. We don&apos;t get your Google password or access to
            any other Google data.
          </li>
          <li>
            <strong className="text-white">Orders and billing</strong> — the plans you buy, invoices, amounts, GST, and
            payment/subscription IDs from Razorpay. Card, UPI and bank details are entered on Razorpay&apos;s checkout
            and are never stored by us.
          </li>
          <li>
            <strong className="text-white">Server information</strong> — hostname, IP addresses, region, operating
            system and resource usage (CPU, memory, disk) of servers you run with us, used to operate and scale them.
          </li>
          <li>
            <strong className="text-white">Support</strong> — messages you send us through tickets or email.
          </li>
          <li>
            <strong className="text-white">Technical logs</strong> — IP address, browser type and request logs kept
            for security and troubleshooting.
          </li>
        </List>
      </Section>

      <Section title="2. Data on your servers">
        <p>
          Files, databases and applications you put on your server belong to you. We don&apos;t access, read or
          share them, except where you ask us to for support, where it&apos;s needed to keep the platform secure (for
          example, investigating abuse), or where the law requires it.
        </p>
      </Section>

      <Section title="3. How we use your data">
        <List>
          <li>To create and manage your account and sign you in.</li>
          <li>To set up, run, monitor and automatically scale your servers.</li>
          <li>To take payments, run autopay renewals and issue GST invoices.</li>
          <li>
            To send service emails: invoices, setup details, renewal and payment-failure notices, suspension and
            deletion warnings, and password resets.
          </li>
          <li>To answer support requests and to prevent fraud and abuse.</li>
          <li>To meet legal, tax and accounting obligations.</li>
        </List>
        <p>We don&apos;t sell your data, and we don&apos;t use it for advertising.</p>
      </Section>

      <Section title="4. Who we share it with">
        <p>Only with the service providers we need to run Sowsi Cloud, each for its own purpose:</p>
        <List>
          <li>
            <strong className="text-white">Razorpay</strong> — payments and autopay mandates.
          </li>
          <li>
            <strong className="text-white">Hetzner Online</strong> — data-centre infrastructure that hosts our servers
            (Nuremberg, Germany).
          </li>
          <li>
            <strong className="text-white">Resend</strong> — delivery of our service emails.
          </li>
          <li>
            <strong className="text-white">Google</strong> — only if you choose to sign in with Google.
          </li>
        </List>
        <p>We may also disclose data where required by law or by a valid order from a government authority.</p>
      </Section>

      <Section title="5. Where your data is stored">
        <p>
          Your account data and servers are hosted in data centres in Germany. By using the service you agree to your
          data being processed there, with the safeguards described in this policy.
        </p>
      </Section>

      <Section title="6. Cookies">
        <p>We use only the cookies needed to make the site work — no analytics or advertising cookies:</p>
        <List>
          <li>
            <code className="text-gray-200">auth_token</code> — keeps you signed in (expires after 7 days).
          </li>
          <li>
            <code className="text-gray-200">google_oauth_state</code> — protects Google sign-in from forgery (expires
            after 10 minutes).
          </li>
        </List>
        <p>Your browser also stores your basic profile locally so the dashboard loads quickly.</p>
      </Section>

      <Section title="7. How long we keep it">
        <List>
          <li>Account data — while your account is open, and deleted after you ask us to close it.</li>
          <li>
            Server data — deleted when the server is deleted, including servers deleted for non-payment as described
            in our <Link href="/terms" className="text-blue-400 hover:underline">Terms of Service</Link>.
          </li>
          <li>Invoices and payment records — for as long as Indian tax and accounting laws require.</li>
        </List>
      </Section>

      <Section title="8. Your rights">
        <p>
          Subject to applicable law, including India&apos;s Digital Personal Data Protection Act, 2023, you can ask us
          to access, correct or delete your personal data, or to close your account. Email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-blue-400 hover:underline">{SUPPORT_EMAIL}</a> from the
          address on your account and we&apos;ll respond within 30 days. Some records (like invoices) must be kept
          even after an account is closed.
        </p>
      </Section>

      <Section title="9. Security">
        <p>
          We use HTTPS everywhere, hashed passwords, signed sessions and restricted access to our systems. No system is
          perfectly secure; if a breach affects your personal data, we&apos;ll notify you and the authorities as the
          law requires.
        </p>
      </Section>

      <Section title="10. Children">
        <p>Sowsi Cloud is not meant for anyone under 18, and we don&apos;t knowingly collect their data.</p>
      </Section>

      <Section title="11. Changes to this policy">
        <p>
          If we make significant changes, we&apos;ll email you or show a notice in your dashboard before they take
          effect. The date at the top shows when this policy was last updated.
        </p>
      </Section>
    </LegalPage>
  );
}
