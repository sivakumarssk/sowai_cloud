import Link from "next/link";
import Image from "next/image";
import Navbar from "@/components/landing/Navbar";
import HeroAnimation from "@/components/landing/HeroAnimation";
import FeatureCard from "@/components/landing/FeatureCard";
import sowsiLogo from "@/assets/sowsi-logo.png";

const features = [
  {
    icon: "⚡",
    title: "NVMe SSD Storage",
    desc: "Local NVMe SSD storage on every server.",
  },
  {
    icon: "🛡️",
    title: "99.9% Uptime Target",
    desc: "A target for single-server hosting, with no SLA credits.",
  },
  {
    icon: "🎧",
    title: "Ticket & Email Support",
    desc: "Support by ticket and email.",
  },
  {
    icon: "🔒",
    title: "Ready for Your SSL",
    desc: "Ports 80 and 443 are open for your own SSL.",
  },
  {
    icon: "🚀",
    title: "Quick Setup",
    desc: "Your server is usually ready within minutes of payment.",
  },
];

export default function LandingPage() {
  return (
    <div style={{ background: "linear-gradient(135deg, #0B1120 0%, #0F172A 50%, #0B1120 100%)", minHeight: "100vh" }}>
      <Navbar />

      {/* ── HERO ── */}
      <section className="relative overflow-hidden">
        {/* Ambient glows */}
        <div className="pointer-events-none absolute inset-0">
          <div style={{ position: "absolute", top: "-10%", left: "20%", width: 600, height: 600, background: "radial-gradient(circle, rgba(27,79,232,0.15) 0%, transparent 70%)", borderRadius: "50%" }} />
          <div style={{ position: "absolute", bottom: "0%", right: "10%", width: 400, height: 400, background: "radial-gradient(circle, rgba(14,165,233,0.1) 0%, transparent 70%)", borderRadius: "50%" }} />
        </div>

        <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 pb-20 lg:pt-24 lg:pb-28">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 lg:gap-8 items-center">

            {/* Left — copy */}
            <div className="text-center lg:text-left">
              <div className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium mb-6"
                style={{ background: "rgba(27,79,232,0.12)", border: "1px solid rgba(27,79,232,0.35)", color: "#93C5FD" }}>
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse inline-block" />
                VPS from ₹599/month on a 1-year term
              </div>

              <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black text-white leading-tight tracking-tight mb-5">
                Cloud Hosting<br />
                Built for{" "}
                <span style={{ background: "linear-gradient(90deg, #3B82F6, #0EA5E9)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                  Indian Businesses
                </span>
              </h1>

              <p className="text-gray-400 text-lg leading-relaxed mb-8 max-w-lg mx-auto lg:mx-0">
                NVMe SSD hosting with GST invoices and UPI payments.
              </p>

              <div className="flex flex-col sm:flex-row gap-3 justify-center lg:justify-start">
                <Link href="/signup">
                  <button className="w-full sm:w-auto px-7 py-3.5 rounded-xl text-base font-semibold text-white transition-all hover:opacity-90 active:scale-95 shadow-lg"
                    style={{ background: "linear-gradient(135deg, #1B4FE8, #0EA5E9)", boxShadow: "0 0 30px rgba(27,79,232,0.35)" }}>
                    Get Started →
                  </button>
                </Link>
                <Link href="/pricing">
                  <button className="w-full sm:w-auto px-7 py-3.5 rounded-xl text-base font-semibold text-gray-200 transition-all hover:bg-white/10 hover:text-white"
                    style={{ border: "1px solid rgba(255,255,255,0.12)" }}>
                    View All Plans
                  </button>
                </Link>
              </div>

            </div>

            {/* Right — 3D animation */}
            <div className="flex justify-center lg:justify-end">
              <HeroAnimation />
            </div>
          </div>
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section id="features" className="py-20 lg:py-28" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-14">
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-3">Everything you need online</h2>
            <p className="text-gray-400 text-lg max-w-xl mx-auto">
              VPS hosting for Indian businesses, on servers in Germany.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {features.map((f) => (
              <FeatureCard key={f.title} icon={f.icon} title={f.title} desc={f.desc} />
            ))}
          </div>
        </div>
      </section>

      {/* ── WHY US ── */}
      <section id="why-us" className="py-20 lg:py-28" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl sm:text-4xl font-bold text-white mb-8">
                Why Indian businesses choose Sowsi Cloud
              </h2>
              <div className="flex flex-col gap-6">
                {[
                  { icon: "🏙️", title: "Local Hyderabad Company", desc: "Our team is based in Hyderabad." },
                  { icon: "🧾", title: "GST Invoices", desc: "Every payment generates a proper GST invoice for tax purposes." },
                  { icon: "💳", title: "UPI & Indian Payments", desc: "Pay by UPI, card or netbanking." },
                ].map((item) => (
                  <div key={item.title} className="flex items-start gap-4">
                    <div className="text-2xl shrink-0 mt-0.5">{item.icon}</div>
                    <div>
                      <h3 className="text-white font-semibold mb-1">{item.title}</h3>
                      <p className="text-gray-400 text-sm leading-relaxed">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-2xl p-8" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
              <h3 className="text-white font-bold text-xl mb-7">Start hosting in 4 steps</h3>
              <div className="flex flex-col gap-5">
                {[
                  { step: "1", title: "Create account", desc: "Sign up with your email and mobile number" },
                  { step: "2", title: "Choose a plan", desc: "Pick the right plan for your business" },
                  { step: "3", title: "Pay with UPI", desc: "Setup usually starts right after you pay" },
                  { step: "4", title: "Go live!", desc: "Your server is usually ready within minutes" },
                ].map((s) => (
                  <div key={s.step} className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0"
                      style={{ background: "linear-gradient(135deg, #1B4FE8, #0EA5E9)" }}>
                      {s.step}
                    </div>
                    <div>
                      <p className="text-white font-medium text-sm">{s.title}</p>
                      <p className="text-gray-500 text-xs mt-0.5">{s.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
              <Link href="/signup" className="block mt-7">
                <button className="w-full py-3 rounded-xl font-semibold text-white text-sm transition-all hover:opacity-90"
                  style={{ background: "linear-gradient(135deg, #1B4FE8, #0EA5E9)" }}>
                  Get Started
                </button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="py-20 lg:py-28" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <div className="max-w-3xl mx-auto px-4 text-center">
          <div className="rounded-3xl p-10 sm:p-14"
            style={{ background: "linear-gradient(135deg, rgba(27,79,232,0.15) 0%, rgba(14,165,233,0.1) 100%)", border: "1px solid rgba(27,79,232,0.3)" }}>
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">Ready for Sowsi Cloud?</h2>
            <p className="text-gray-400 text-lg mb-8">VPS from ₹599/month on a 1-year term.</p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link href="/signup">
                <button className="w-full sm:w-auto px-8 py-3.5 rounded-xl font-semibold text-white text-base transition-all hover:opacity-90"
                  style={{ background: "linear-gradient(135deg, #1B4FE8, #0EA5E9)", boxShadow: "0 0 30px rgba(27,79,232,0.4)" }}>
                  Get Started
                </button>
              </Link>
              <a href="mailto:sales@sowsicloud.com">
                <button className="w-full sm:w-auto px-8 py-3.5 rounded-xl font-semibold text-gray-200 text-base transition-all hover:bg-white/10 hover:text-white"
                  style={{ border: "1px solid rgba(255,255,255,0.12)" }}>
                  Talk to sales
                </button>
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }} className="py-14">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-8 mb-10">
            <div className="col-span-2 md:col-span-1">
              <Link href="/" className="flex items-center gap-2 mb-4 w-fit">
                <Image src={sowsiLogo} alt="Sowsi Cloud" className="h-7 w-auto shrink-0" />
                <span className="font-bold text-white">Sowsi Cloud</span>
              </Link>
              <p className="text-gray-500 text-sm leading-relaxed">Cloud hosting for Indian businesses. Hyderabad, Telangana.</p>
            </div>

            {[
              {
                title: "Products",
                links: [
                  { href: "/pricing", label: "VPS Hosting" },
                  // { href: "/pricing", label: "Object Storage" }, // hidden for now
                  { href: "/pricing", label: "Flat-rate VPS" },
                ],
              },
              {
                title: "Hosting by Stack",
                links: [
                  { href: "/hosting/spring-boot", label: "Spring Boot Hosting" },
                  { href: "/hosting/nodejs", label: "Node.js Hosting" },
                  { href: "/hosting/python-django", label: "Python & Django Hosting" },
                  { href: "/hosting/fastapi", label: "FastAPI Hosting" },
                  { href: "/hosting/machine-learning", label: "Machine Learning Hosting" },
                  { href: "/hosting/mobile-app-backend", label: "Mobile App Backend Hosting" },
                  { href: "/hosting/automation", label: "Automation & Bot Hosting" },
                ],
              },
              {
                title: "Company",
                links: [
                  { href: "/#why-us", label: "About Us" },
                  { href: "/pricing", label: "Pricing" },
                  { href: "/#features", label: "Features" },
                ],
              },
              {
                title: "Support",
                links: [
                  { href: "/login", label: "Open Ticket" },
                  { href: "mailto:support@sowsicloud.com", label: "Email Support" },
                  { href: "mailto:sales@sowsicloud.com", label: "Sales" },
                  { href: "/signup", label: "Get Started" },
                ],
              },
            ].map((col) => (
              <div key={col.title}>
                <h4 className="text-white font-semibold text-sm mb-4">{col.title}</h4>
                <ul className="flex flex-col gap-2.5">
                  {col.links.map((link) => (
                    <li key={link.label}>
                      <Link href={link.href} className="text-gray-500 hover:text-gray-300 text-sm transition-colors">
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-8"
            style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
            <p className="text-gray-600 text-sm">© {new Date().getFullYear()} Sowsi Cloud Services. All rights reserved.</p>
            <div className="flex items-center gap-6">
              <Link href="/privacy" className="text-gray-600 hover:text-gray-400 text-xs transition-colors">Privacy</Link>
              <Link href="/terms" className="text-gray-600 hover:text-gray-400 text-xs transition-colors">Terms</Link>
              <Link href="/refund" className="text-gray-600 hover:text-gray-400 text-xs transition-colors">Refund</Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
