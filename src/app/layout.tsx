import type { Metadata } from "next";
import { IBM_Plex_Sans, JetBrains_Mono } from "next/font/google";
import AuthSessionSync from "@/components/AuthSessionSync";
import "./globals.css";

// Fonts per DESIGN.md §3: Plex for UI, JetBrains Mono for IPs, hostnames and specs.
const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Sowsi Cloud Services — Hosting Built for Indian Businesses",
  description:
    "VPS hosting in Germany for Indian businesses, with GST invoices and UPI payments.",
  keywords:
    "cloud hosting india, vps hosting india, spring boot hosting, node js hosting, python django hosting, fastapi hosting, machine learning hosting, mobile app backend hosting, automation bot hosting, sowsi cloud",
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
    <html lang="en" className={`${plexSans.variable} ${jetbrainsMono.variable} h-full`}>
      <body className="min-h-full bg-canvas text-fg font-sans antialiased">
        <AuthSessionSync />
        {children}
      </body>
    </html>
  );
}
