import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';

// Self-hosted UI font (next/font/local inlines the @font-face and serves the
// file from /_next/static) — the student UI makes no request to any font CDN.
const geistSans = localFont({
  src: './fonts/GeistVF.woff',
  variable: '--font-geist-sans',
  weight: '100 900',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'МУ-Плевен AI Library',
  description: 'AI академичен асистент на Медицински университет Плевен',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="bg" className={geistSans.variable}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
