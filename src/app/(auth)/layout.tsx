import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { ToastContainer } from "@/components/ui/Toast";
import sowsiLogo from "@/assets/sowsi-logo.png";

export const metadata: Metadata = {
  title: "Sowsi Cloud — Sign in or Create Account",
};

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#0A0F1E] flex flex-col">
      {/* Background glows */}
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-[#1B4FE8]/8 blur-[120px] rounded-full pointer-events-none" />
      <div className="fixed bottom-0 right-0 w-[400px] h-[300px] bg-[#0EA5E9]/5 blur-[100px] rounded-full pointer-events-none" />

      {/* Header */}
      <header className="relative z-10 px-6 py-4 border-b border-white/5">
        <Link href="/" className="flex items-center w-fit">
          <Image src={sowsiLogo} alt="Sowsi Cloud" className="h-8 w-auto shrink-0" priority />
        </Link>
      </header>

      {/* Content */}
      <main className="relative z-10 flex-1 flex items-center justify-center px-4 py-10">
        {children}
      </main>

      {/* Footer */}
      <footer className="relative z-10 px-6 py-4 border-t border-white/5 text-center">
        <p className="text-gray-600 text-xs">
          © {new Date().getFullYear()} Sowsi Cloud Services. Hyderabad, India.
        </p>
      </footer>

      <ToastContainer />
    </div>
  );
}
