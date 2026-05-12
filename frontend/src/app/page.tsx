import Link from 'next/link';
import { SignedIn, SignedOut, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';

// required by @cloudflare/next-on-pages bcos clerk turns this into dynamic routing
export const runtime = 'edge';

export default function Home() {
  return (
    <main style={{ padding: '4rem', fontFamily: 'system-ui, sans-serif' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '3rem',
        }}
      >
        <h1 style={{ fontSize: '2rem', fontWeight: 700, margin: 0 }}>Orbital</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <SignedOut>
            <SignInButton mode="modal">
              <button type="button" style={btnGhost}>Sign in</button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button type="button" style={btnPrimary}>Sign up</button>
            </SignUpButton>
          </SignedOut>
          <SignedIn>
            <Link href="/dashboard" style={btnPrimary}>Dashboard</Link>
            <UserButton />
          </SignedIn>
        </div>
      </header>
      <p style={{ color: '#94a3b8', maxWidth: '36rem' }}>
        Algorithmic trading sandbox — dashboard coming soon.
      </p>
    </main>
  );
}

const btnGhost: React.CSSProperties = {
  padding: '0.5rem 1rem',
  borderRadius: '0.375rem',
  border: '1px solid #334155',
  background: 'transparent',
  color: '#e2e8f0',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const btnPrimary: React.CSSProperties = {
  padding: '0.5rem 1rem',
  borderRadius: '0.375rem',
  background: '#2563eb',
  color: '#fff',
  textDecoration: 'none',
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontWeight: 500,
};
