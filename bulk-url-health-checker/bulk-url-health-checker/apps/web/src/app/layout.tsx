import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';

export const metadata = {
  title: 'Bulk URL Health Checker',
  description: 'Submit URLs, watch them get checked in the background.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <header className="app-header">
            <Link href="/batches" className="app-title">
              Bulk URL Health Checker
            </Link>
          </header>
          <main className="app-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
