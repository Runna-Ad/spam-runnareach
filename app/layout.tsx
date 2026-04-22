import type { Metadata } from "next";
import { Inter, Poppins } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  display: "swap",
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "S.P.A.M. — Runna CA Opportunity Engine",
  description:
    "Smart Prospecting & Acquisition Machine. Human-in-the-loop AI sales system for Runna CA.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${poppins.variable} ${inter.variable} dark`}>
      <body className="min-h-screen bg-[var(--color-bg-900)] text-[var(--color-fg-50)] antialiased">
        {children}
        <Toaster
          theme="dark"
          position="bottom-right"
          toastOptions={{
            style: {
              background: "var(--color-bg-800)",
              color: "var(--color-fg-50)",
              border: "1px solid var(--color-border-default)",
            },
          }}
        />
      </body>
    </html>
  );
}
