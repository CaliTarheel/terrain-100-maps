import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);
  const socialImage = new URL("/og.png", metadataBase).toString();

  return {
    metadataBase,
    title: "Terrain / 100 — Real ground, MBT-style maps.",
    description:
      "Classify a real-world location into one clean 100-meter MBT-style board or a seamless multi-board mosaic.",
    openGraph: {
      type: "website",
      url: metadataBase.toString(),
      title: "Terrain / 100",
      description: "Real ground, classified into playable single- and multi-board MBT-style maps.",
      images: [
        {
          url: socialImage,
          alt: "Terrain / 100 tactical map workbench",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Terrain / 100",
      description: "Real ground, classified into playable single- and multi-board MBT-style maps.",
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
