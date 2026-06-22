import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { UserSyncer } from "../components/UserSyncer";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Bubbles",
  description: "A self-hostable mock algorithmic trading platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // afterSignOutUrl pins the post-logout redirect to this app's landing page
    // on whatever domain it's deployed to. Without it Clerk falls back to its
    // dashboard-configured URL (often localhost for a dev instance), which is
    // the deployed "logout sends me to the wrong place" bug.
    <ClerkProvider afterSignOutUrl="/">
      <html lang="en">
        <body
          className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        >
          <UserSyncer />
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
