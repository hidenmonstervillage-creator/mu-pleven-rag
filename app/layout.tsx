import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'МУ-Плевен AI Library',
  description: 'AI академичен асистент на Медицински университет Плевен',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="bg">
      <body className="antialiased">{children}</body>
    </html>
  );
}
