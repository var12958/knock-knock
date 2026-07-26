import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { FirebaseAuthProvider } from "@/context/FirebaseAuthContext";
import { Web3Provider } from "@/context/Web3Context";
import Web3Header from "@/components/Web3Header";

const inter = Inter({ subsets: ["latin"] });

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
    <html lang="en">
      <body className={inter.className}>
        <FirebaseAuthProvider>
          <Web3Provider>
            <Web3Header />
            <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
          </Web3Provider>
        </FirebaseAuthProvider>
      </body>
    </html>
  );
}
