import type { Metadata } from "next";
import { Inter } from "next/font/google";
import AuthSessionSync from "@/components/AuthSessionSync";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Sowsi Cloud Services — Hosting Built for Indian Businesses",
  description:
    "Fast, reliable cloud hosting in India. Shared hosting, VPS, WordPress hosting, and object storage with GST invoices, UPI payments, and 24/7 support.",
  keywords:
    "cloud hosting india, vps hosting india, wordpress hosting, object storage, dedicated server hosting india, spring boot hosting, node js hosting, python django hosting, fastapi hosting, machine learning hosting, mobile app backend hosting, automation bot hosting, sowsi cloud",
  openGraph: {
    title: "Sowsi Cloud Services",
    description: "Cloud Hosting Built for Indian Businesses",
    url: "https://sowsicloud.com",
    siteName: "Sowsi Cloud",
    locale: "en_IN",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} h-full`}>
      <body className="min-h-full bg-[#0A0F1E] text-white antialiased">
        <AuthSessionSync />
        {children}
      </body>
    </html>
  );
}
