import type { Metadata } from "next";
import Link from "next/link";
import Navbar from "@/components/landing/Navbar";
import { HOSTING_STACKS } from "@/lib/hostingStacks";

export const metadata: Metadata = {
  title: "Hosting by Technology — Spring Boot, Node.js, Python, FastAPI, ML & More | Sowsi Cloud",
  description:
    "Find the right hosting for your stack: Spring Boot, Node.js, Python/Django, FastAPI, Machine Learning, Mobile App Backends, Automation Bots, WordPress, and Websites.",
  keywords:
    "tech stack hosting india, spring boot hosting, node js hosting, python hosting, fastapi hosting, machine learning hosting, mobile backend hosting, automation hosting",
};

export default function HostingIndexPage() {
  return (
    <div style={{ background: "linear-gradient(135deg, #0B1120 0%, #0F172A 50%, #0B1120 100%)", minHeight: "100vh" }}>
      <Navbar />

      <section className="pt-14 pb-10 text-center px-4">
        <div className="inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium mb-5"
          style={{ background: "rgba(27,79,232,0.12)", border: "1px solid rgba(27,79,232,0.35)", color: "#93C5FD" }}>
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse inline-block" />
          Hosting for every tech stack
        </div>
        <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black text-white mb-3 tracking-tight">
          Hosting Built for Your Stack
        </h1>
        <p className="text-gray-400 text-base sm:text-lg max-w-2xl mx-auto">
          Whether you build with Spring Boot, Node.js, Python, or you&apos;re running ML models and automation bots —
          find the right plan for your framework, pre-matched to the right server type.
        </p>
      </section>

      <section className="pb-20 px-4">
        <div className="max-w-6xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {HOSTING_STACKS.map((stack) => (
            <Link key={stack.slug} href={`/hosting/${stack.slug}`}
              className="group rounded-2xl p-6 flex flex-col transition-all duration-200"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)" }}>
              <span className="text-3xl mb-3">{stack.icon}</span>
              <h2 className="text-lg font-bold text-white mb-1.5 group-hover:text-[#60A5FA] transition-colors">
                {stack.name}
              </h2>
              <p className="text-gray-400 text-sm mb-4 flex-1">{stack.tagline}</p>
              <span className="text-sm font-medium text-[#60A5FA] inline-flex items-center gap-1">
                View plans →
              </span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
