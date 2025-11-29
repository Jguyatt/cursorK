/**
 * Credit Storage System
 * 
 * Production: Uses Supabase PostgreSQL database
 * 
 * This module provides a unified interface for credit operations.
 * All functions are async and use Supabase for storage.
 */

export interface UserCredits {
  userId: string;
  totalCredits: number;
  usedCredits: number;
  remainingCredits: number;
  planId: string;
  lastUpdated: string;
  subscriptionId?: string;
}

// Re-export all functions from Supabase storage
export {
  getUserCredits,
  initializeCredits,
  updateCredits,
  deductCredits,
  hasEnoughCredits,
  getAllCredits,
  resetCreditsForRenewal,
} from './supabase-storage';
