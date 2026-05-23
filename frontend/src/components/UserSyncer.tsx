'use client';

import { useUserSync } from "../hooks/useUserSync";

export function UserSyncer() {
  useUserSync();
  return null;
}
