import Link from "next/link";
import Navbar from "@/components/landing/Navbar";

export const LEGAL_UPDATED = "28 October 2026";
export const SUPPORT_EMAIL = "support@sowsicloud.com";

const LEGAL_LINKS = [
  { href: "/terms", label: "Terms of Service" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/refund", label: "Refund Policy" },
];

/** Shared shell for the Terms / Privacy / Refund pages. */
export default function LegalPage({
  title,
  intro,
  current,
  children,
}: {
  title: string;
  intro: React.ReactNode;
  current: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ background: "linear-gradient(135deg, #0B1120 0%, #0F172A 50%, #0B1120 100%)", minHeight: "100vh" }}>
      <Navbar />
      <article className="max-w-3xl mx-auto px-4 sm:px-6 pt-12 pb-20">
        <nav aria-label="Legal" className="flex flex-wrap gap-2 mb-8">
          {LEGAL_LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={l.href === current ? "page" : undefined}
              className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                l.href === current
                  ? "border-blue-500/50 bg-blue-500/10 text-blue-300"
                  : "border-white/10 text-gray-400 hover:text-gray-200 hover:border-white/20"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight">{title}</h1>
        <p className="text-gray-500 text-sm mt-2">Last updated: {LEGAL_UPDATED}</p>
        <div className="text-gray-300 text-[15px] leading-relaxed mt-6">{intro}</div>

        <div className="mt-10 flex flex-col gap-10">{children}</div>

        <p className="mt-14 pt-6 border-t border-white/10 text-gray-400 text-sm">
          Questions? Email us at{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-blue-400 hover:underline">
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </article>
    </div>
  );
}

export function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="text-xl font-bold text-white mb-3">{title}</h2>
      <div className="flex flex-col gap-3 text-gray-300 text-[15px] leading-relaxed">{children}</div>
    </section>
  );
}

export function List({ children }: { children: React.ReactNode }) {
  return <ul className="list-disc pl-5 flex flex-col gap-1.5 marker:text-gray-500">{children}</ul>;
}
