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
    desc: "Ultra-fast NVMe SSDs — 10x faster than traditional HDDs.",
  },
  {
    icon: "🛡️",
    title: "99.9% Uptime SLA",
    desc: "Guaranteed uptime backed by redundant infrastructure.",
  },
  {
    icon: "🎧",
    title: "24/7 Expert Support",
    desc: "Reach us in Telugu, Hindi, or English. Real humans, not bots.",
  },
  {
    icon: "🔒",
    title: "Free SSL Certificates",
    desc: "Automatic Let's Encrypt SSL for all your domains.",
  },
  {
    icon: "💾",
    title: "Daily Backups",
    desc: "Automated backups with 7-day retention. Always safe.",
  },
  {
    icon: "🚀",
    title: "Instant Provisioning",
    desc: "Your hosting is live in minutes — no waiting.",
  },
];

const plans = [
  {
    name: "Starter",
    price: 99,
    monthlyPrice: 109,
    features: ["1 Website", "10 GB NVMe SSD", "Unlimited Bandwidth", "Free SSL", "1 Email"],
    popular: false,
    href: "/signup?plan=shared-starter&cycle=12",
  },
  {
    name: "Business",
    price: 199,
    monthlyPrice: 219,
    features: ["5 Websites", "30 GB NVMe SSD", "Unlimited Bandwidth", "Free SSL", "10 Emails", "Daily Backup"],
    popular: true,
    href: "/signup?plan=shared-business&cycle=12",
  },
  {
    name: "Enterprise",
    price: 299,
    monthlyPrice: 329,
    features: ["Unlimited Websites", "100 GB NVMe SSD", "Unlimited Bandwidth", "Free SSL", "Unlimited Emails", "Priority Support"],
    popular: false,
    href: "/signup?plan=shared-enterprise&cycle=12",
  },
];

const testimonials = [
  {
    name: "Arjun Reddy",
    role: "Founder, TechSphere Hyderabad",
    initials: "AR",
    quote: "Switched to Sowsi Cloud and my site load time dropped by 60%. The Telugu support team is a lifesaver!",
  },
  {
    name: "Priya Sharma",
    role: "WordPress Developer, Bangalore",
    initials: "PS",
    quote: "GST invoices make expense filing so easy. Affordable pricing and rock-solid uptime.",
  },
  {
    name: "Vikram Nair",
    role: "E-commerce Owner, Kochi",
    initials: "VN",
    quote: "UPI payment support and instant setup. My Razorpay storefront was live in 20 minutes!",
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
                Starting at ₹99/month · Billed annually
              </div>

              <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black text-white leading-tight tracking-tight mb-5">
                Cloud Hosting<br />
                Built for{" "}
                <span style={{ background: "linear-gradient(90deg, #3B82F6, #0EA5E9)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                  Indian Businesses
                </span>
              </h1>

              <p className="text-gray-400 text-lg leading-relaxed mb-8 max-w-lg mx-auto lg:mx-0">
                NVMe SSD hosting with GST invoices, UPI payments, and support in Telugu, Hindi & English.
              </p>

              <div className="flex flex-col sm:flex-row gap-3 justify-center lg:justify-start">
                <Link href="/signup">
                  <button className="w-full sm:w-auto px-7 py-3.5 rounded-xl text-base font-semibold text-white transition-all hover:opacity-90 active:scale-95 shadow-lg"
                    style={{ background: "linear-gradient(135deg, #1B4FE8, #0EA5E9)", boxShadow: "0 0 30px rgba(27,79,232,0.35)" }}>
                    Get Started Free →
                  </button>
                </Link>
                <Link href="/pricing">
                  <button className="w-full sm:w-auto px-7 py-3.5 rounded-xl text-base font-semibold text-gray-200 transition-all hover:bg-white/10 hover:text-white"
                    style={{ border: "1px solid rgba(255,255,255,0.12)" }}>
                    View All Plans
                  </button>
                </Link>
              </div>

              {/* Stats */}
              <div className="mt-10 grid grid-cols-4 gap-4 max-w-md mx-auto lg:mx-0">
                {[
                  { v: "99.9%", l: "Uptime" },
                  { v: "500+", l: "Clients" },
                  { v: "24/7", l: "Support" },
                  { v: "₹99", l: "From" },
                ].map((s) => (
                  <div key={s.l} className="text-center">
                    <div className="text-xl sm:text-2xl font-black text-white">{s.v}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{s.l}</div>
                  </div>
                ))}
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
              Enterprise-grade infrastructure at Indian prices.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {features.map((f) => (
              <FeatureCard key={f.title} icon={f.icon} title={f.title} desc={f.desc} />
            ))}
          </div>
        </div>
      </section>

      {/* ── PRICING PREVIEW ── */}
      <section className="py-20 lg:py-28" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-14">
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-3">Simple, transparent pricing</h2>
            <p className="text-gray-400 text-lg">No surprise bills. GST invoice included. Cancel anytime.</p>
            <div className="inline-flex items-center gap-2 mt-4 text-sm font-medium"
              style={{ color: "#34D399" }}>
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              5% off with annual billing — prices shown per month
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto">
            {plans.map((plan) => {
              const dim = plan.popular ? "rgba(219,234,254,0.7)" : "#6B7280";
              return (
                <div key={plan.name} className="relative rounded-2xl p-6 flex flex-col"
                  style={plan.popular
                    ? { background: "linear-gradient(145deg, #1B4FE8, #1540C4)", border: "2px solid #1B4FE8", boxShadow: "0 20px 60px rgba(27,79,232,0.3)" }
                    : { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }
                  }>
                  {plan.popular && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 text-xs font-bold px-3 py-1 rounded-full whitespace-nowrap"
                      style={{ background: "#FBBF24", color: "#000" }}>
                      MOST POPULAR
                    </div>
                  )}
                  <div className="mb-5">
                    <h3 className="text-xl font-bold text-white">{plan.name}</h3>
                    <p className={`text-xs mt-0.5 ${plan.popular ? "text-blue-200" : "text-gray-500"}`}>Shared Hosting</p>
                  </div>
                  <div className="mb-6">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm line-through" style={{ color: dim }}>₹{plan.monthlyPrice}/mo</span>
                      <span className="text-xs font-semibold px-1.5 py-0.5 rounded-full"
                        style={{ background: "rgba(16,185,129,0.15)", color: "#34D399" }}>5% OFF</span>
                    </div>
                    <div className="flex items-end gap-1">
                      <span className="text-4xl font-black text-white leading-none">₹{plan.price}</span>
                      <span className="text-sm mb-1" style={{ color: dim }}>/mo</span>
                    </div>
                    <p className="text-xs mt-1.5" style={{ color: plan.popular ? "#93C5FD" : "#60A5FA" }}>
                      ₹{(plan.price * 12).toLocaleString("en-IN")} billed annually + GST
                    </p>
                  </div>
                  <ul className="flex flex-col gap-2.5 flex-1 mb-6">
                    {plan.features.map((feat) => (
                      <li key={feat} className="flex items-center gap-2 text-sm">
                        <svg className={`w-4 h-4 shrink-0 ${plan.popular ? "text-blue-200" : "text-blue-500"}`} fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                        <span className={plan.popular ? "text-blue-100" : "text-gray-300"}>{feat}</span>
                      </li>
                    ))}
                  </ul>
                  <Link href={plan.href}>
                    <button className="w-full py-2.5 rounded-xl font-semibold text-sm transition-all hover:opacity-90"
                      style={plan.popular
                        ? { background: "#fff", color: "#1B4FE8" }
                        : { background: "rgba(27,79,232,0.15)", color: "#93C5FD", border: "1px solid rgba(27,79,232,0.3)" }}>
                      Get Started
                    </button>
                  </Link>
                </div>
              );
            })}
          </div>

          <div className="text-center mt-8">
            <Link href="/pricing" className="text-blue-400 hover:text-blue-300 text-sm font-medium transition-colors">
              See VPS, WordPress & Object Storage plans →
            </Link>
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
                  { icon: "🏙️", title: "Local Hyderabad Company", desc: "Our team is based in Hyderabad, support in Telugu, Hindi & English." },
                  { icon: "🧾", title: "GST Invoices", desc: "Every payment generates a proper GST invoice for tax purposes." },
                  { icon: "💳", title: "UPI & Indian Payments", desc: "Pay via UPI, NEFT, credit/debit card, or netbanking." },
                  { icon: "🤝", title: "Personal Support", desc: "Dedicated account manager, not a ticket queue. We pick up the phone." },
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
                  { step: "3", title: "Pay with UPI", desc: "Instant payment, instant provisioning" },
                  { step: "4", title: "Go live!", desc: "Your site is live in minutes" },
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
                  Start for ₹99/month
                </button>
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ── TESTIMONIALS ── */}
      <section id="testimonials" className="py-20 lg:py-28" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-14">
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-3">Trusted by businesses across India</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {testimonials.map((t) => (
              <div key={t.name} className="rounded-2xl p-6"
                style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
                <div className="flex gap-0.5 mb-4">
                  {[1,2,3,4,5].map((i) => (
                    <svg key={i} className="w-4 h-4 text-amber-400" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                  ))}
                </div>
                <p className="text-gray-300 text-sm leading-relaxed mb-5 italic">&ldquo;{t.quote}&rdquo;</p>
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
                    style={{ background: "linear-gradient(135deg, #1B4FE8, #0EA5E9)" }}>
                    {t.initials}
                  </div>
                  <div>
                    <p className="text-white text-sm font-medium">{t.name}</p>
                    <p className="text-gray-500 text-xs">{t.role}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="py-20 lg:py-28" style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
        <div className="max-w-3xl mx-auto px-4 text-center">
          <div className="rounded-3xl p-10 sm:p-14"
            style={{ background: "linear-gradient(135deg, rgba(27,79,232,0.15) 0%, rgba(14,165,233,0.1) 100%)", border: "1px solid rgba(27,79,232,0.3)" }}>
            <h2 className="text-3xl sm:text-4xl font-bold text-white mb-4">Ready for Sowsi Cloud?</h2>
            <p className="text-gray-400 text-lg mb-8">Join 500+ Indian businesses. Start at ₹99/month.</p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link href="/signup">
                <button className="w-full sm:w-auto px-8 py-3.5 rounded-xl font-semibold text-white text-base transition-all hover:opacity-90"
                  style={{ background: "linear-gradient(135deg, #1B4FE8, #0EA5E9)", boxShadow: "0 0 30px rgba(27,79,232,0.4)" }}>
                  Get started for ₹99/mo
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
              <p className="text-gray-600 text-xs mt-3">GSTIN: 36XXXXXXXXXX</p>
            </div>

            {[
              {
                title: "Products",
                links: [
                  { href: "/pricing", label: "Shared Hosting" },
                  { href: "/pricing", label: "VPS Hosting" },
                  { href: "/pricing", label: "WordPress Hosting" },
                  { href: "/pricing", label: "Object Storage" },
                  { href: "/pricing", label: "Dedicated Servers" },
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
                  { href: "/#testimonials", label: "Reviews" },
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
