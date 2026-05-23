'use client';

import { useAuth } from '@clerk/nextjs';
import { useEffect, useRef } from 'react';

export function useUserSync() {
  const { isLoaded, userId, getToken } = useAuth();
  const synced = useRef(false);

  useEffect(() => {
    const syncUser = async () => {
      if (isLoaded && userId && !synced.current) {
        try {
          const token = await getToken();
          const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3010';
          
          const response = await fetch(`${backendUrl}/users/sync`, {
             method: 'POST',
             headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
             }
          });
          
          if (response.ok) {
            synced.current = true;
            console.log('User synced with backend');
          } else {
            console.error('Failed to sync user', await response.text());
          }

        } catch (error) {
          console.error('Error syncing user:', error);
        }
      }
    };

    syncUser();
  }, [isLoaded, userId, getToken]);
}
