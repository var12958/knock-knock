import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { FirebaseAuthProvider } from "@/context/FirebaseAuthContext";
import { Web3Provider } from "@/context/Web3Context";
import Web3Header from "@/components/Web3Header";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "KnockKnock — Web3 Messaging",
  description: "Privacy-first messaging on Flare Coston2",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable}>
      <body className={`${inter.className} min-h-screen`}>
        {/* Subtle ambient depth layer — sits behind all content */}
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
        >
          <div className="absolute -top-40 right-0 h-[32rem] w-[32rem] rounded-full bg-[#DFD0B8]/[0.04] blur-3xl" />
          <div className="absolute bottom-0 left-0 h-[28rem] w-[28rem] rounded-full bg-[#DFD0B8]/[0.03] blur-3xl" />
        </div>

        <FirebaseAuthProvider>
          <Web3Provider>
            <Web3Header />
            <main className="mx-auto min-h-[calc(100vh-5rem)] max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
              {children}
            </main>
          </Web3Provider>
        </FirebaseAuthProvider>
      </body>
    </html>
  );
}