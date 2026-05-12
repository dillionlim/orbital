import Link from 'next/link';
import { auth, currentUser } from '@clerk/nextjs/server';
import { UserButton } from '@clerk/nextjs';

// middleware already redirected anon users away,
// so by the time we render here, 
// userId is guaranteed to be set.
export default async function DashboardPage() {
  const { userId } = await auth();
  const user = await currentUser();

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
        <Link
          href="/"
          style={{ color: '#94a3b8', textDecoration: 'none', fontSize: '0.875rem' }}
        >
          ← Homepage
        </Link>
        <UserButton />
      </header>

      <h1 style={{ fontSize: '2rem', fontWeight: 700, margin: 0 }}>Dashboard</h1>
      <p style={{ color: '#94a3b8', marginTop: '0.5rem' }}>
        Welcome back{user?.firstName ? `, ${user.firstName}` : ''}.
      </p>
      <p style={{ color: '#64748b', marginTop: '2rem', fontSize: '0.875rem' }}>
        Order book coming soon.
      </p>

      <pre
        style={{
          marginTop: '2rem',
          padding: '1rem',
          background: '#1e293b',
          border: '1px solid #334155',
          borderRadius: '0.375rem',
          fontSize: '0.75rem',
          color: '#94a3b8',
          overflowX: 'auto',
        }}
      >
        {`userId: ${userId}`}
      </pre>
    </main>
  );
}
