'use client';

import React from 'react';
import { useOnboarding } from '../hooks/useOnboarding';
import { OnboardingTour } from './OnboardingTour';

// Mount point for the dashboard. Renders nothing until the tour is due, so the
// spotlight's DOM measurements never run against a half-mounted dashboard.
export const Onboarding: React.FC = () => {
  const { isOpen, finish } = useOnboarding();
  if (!isOpen) return null;
  return <OnboardingTour onFinish={finish} />;
};
