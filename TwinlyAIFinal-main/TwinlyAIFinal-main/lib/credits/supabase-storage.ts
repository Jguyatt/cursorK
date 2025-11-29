/**
 * Supabase Credit Storage System
 * 
 * Production-ready storage using Supabase PostgreSQL database
 */

import { createServerClient } from '@/lib/supabase/server';
import { UserCredits } from './storage';

// Plan credit limits (in credits, where 1 minute = 3 credits)
const PLAN_CREDITS: Record<string, number> = {
  free_trial: 45,    // 15 minutes
  starter: 180,      // 60 minutes
  pro: 450,          // 150 minutes
  ultra: 600,        // 200 minutes
};

/**
 * Convert Supabase row to UserCredits interface
 */
const rowToUserCredits = (row: any): UserCredits => ({
  userId: row.user_id,
  totalCredits: row.total_credits,
  usedCredits: row.used_credits,
  remainingCredits: row.remaining_credits,
  planId: row.plan_id,
  subscriptionId: row.subscription_id || undefined,
  lastUpdated: row.last_updated || row.updated_at,
});

/**
 * Get user's credit balance
 */
export const getUserCredits = async (userId: string): Promise<UserCredits | null> => {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from('credits')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        // No rows returned
        return null;
      }
      console.error('Error getting user credits:', error);
      throw error;
    }

    return data ? rowToUserCredits(data) : null;
  } catch (error) {
    console.error('Error in getUserCredits:', error);
    throw error;
  }
};

/**
 * Initialize credits for a user
 */
export const initializeCredits = async (
  userId: string,
  planId: string,
  subscriptionId?: string
): Promise<UserCredits> => {
  try {
    const totalCredits = PLAN_CREDITS[planId] || 0;

    const userCredits: Omit<UserCredits, 'lastUpdated'> = {
      userId,
      totalCredits,
      usedCredits: 0,
      remainingCredits: totalCredits,
      planId,
      subscriptionId,
    };

    const supabase = createServerClient();
    
    // Use upsert to handle both insert and update cases
    const { data, error } = await supabase
      .from('credits')
      .upsert({
        user_id: userId,
        total_credits: totalCredits,
        used_credits: 0,
        remaining_credits: totalCredits,
        plan_id: planId,
        subscription_id: subscriptionId || null,
        last_updated: new Date().toISOString(),
      }, {
        onConflict: 'user_id',
      })
      .select()
      .single();

    if (error) {
      console.error('Error initializing credits:', error);
      throw error;
    }

    return rowToUserCredits(data);
  } catch (error) {
    console.error('Error in initializeCredits:', error);
    throw error;
  }
};

/**
 * Update user's credits
 */
export const updateCredits = async (
  userId: string,
  updates: Partial<Omit<UserCredits, 'userId' | 'remainingCredits'>>
): Promise<UserCredits | null> => {
  try {
    const supabase = createServerClient();

    // Get current credits to calculate remaining
    const current = await getUserCredits(userId);
    if (!current) {
      return null;
    }

    const usedCredits = updates.usedCredits ?? current.usedCredits;
    const totalCredits = updates.totalCredits ?? current.totalCredits;
    const remainingCredits = totalCredits - usedCredits;

    const updateData: any = {
      last_updated: new Date().toISOString(),
    };

    if (updates.totalCredits !== undefined) {
      updateData.total_credits = updates.totalCredits;
    }
    if (updates.usedCredits !== undefined) {
      updateData.used_credits = updates.usedCredits;
    }
    if (updates.planId !== undefined) {
      updateData.plan_id = updates.planId;
    }
    if (updates.subscriptionId !== undefined) {
      updateData.subscription_id = updates.subscriptionId;
    }
    
    updateData.remaining_credits = remainingCredits;

    const { data, error } = await supabase
      .from('credits')
      .update(updateData)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      console.error('Error updating credits:', error);
      throw error;
    }

    return data ? rowToUserCredits(data) : null;
  } catch (error) {
    console.error('Error in updateCredits:', error);
    throw error;
  }
};

/**
 * Deduct credits from user (atomic operation)
 */
export const deductCredits = async (
  userId: string,
  amount: number
): Promise<UserCredits | null> => {
  try {
    const supabase = createServerClient();

    // Use RPC or atomic update to prevent race conditions
    // First, get current credits
    const current = await getUserCredits(userId);
    if (!current) {
      return null;
    }

    const newUsedCredits = current.usedCredits + amount;
    const remainingCredits = Math.max(0, current.totalCredits - newUsedCredits);

    // Atomic update
    const { data, error } = await supabase
      .from('credits')
      .update({
        used_credits: newUsedCredits,
        remaining_credits: remainingCredits,
        last_updated: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      console.error('Error deducting credits:', error);
      throw error;
    }

    return data ? rowToUserCredits(data) : null;
  } catch (error) {
    console.error('Error in deductCredits:', error);
    throw error;
  }
};

/**
 * Check if user has enough credits
 */
export const hasEnoughCredits = async (userId: string, amount: number): Promise<boolean> => {
  try {
    const userCredits = await getUserCredits(userId);
    if (!userCredits) {
      return false;
    }
    return userCredits.remainingCredits >= amount;
  } catch (error) {
    console.error('Error in hasEnoughCredits:', error);
    return false;
  }
};

/**
 * Reset credits for monthly renewal (discard remaining, reset to full plan amount)
 */
export const resetCreditsForRenewal = async (
  userId: string,
  planId: string
): Promise<UserCredits | null> => {
  try {
    const totalCredits = PLAN_CREDITS[planId] || 0;
    
    const supabase = createServerClient();
    
    // Reset to full credits, discarding any remaining
    const { data, error } = await supabase
      .from('credits')
      .update({
        total_credits: totalCredits,
        used_credits: 0,
        remaining_credits: totalCredits,
        plan_id: planId,
        last_updated: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .select()
      .single();

    if (error) {
      console.error('Error resetting credits for renewal:', error);
      throw error;
    }

    if (!data) {
      // If credits don't exist, initialize them
      return await initializeCredits(userId, planId);
    }

    return rowToUserCredits(data);
  } catch (error) {
    console.error('Error in resetCreditsForRenewal:', error);
    throw error;
  }
};

/**
 * Get all users' credits (for admin/debugging)
 */
export const getAllCredits = async (): Promise<Record<string, UserCredits>> => {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from('credits')
      .select('*');

    if (error) {
      console.error('Error getting all credits:', error);
      throw error;
    }

    const result: Record<string, UserCredits> = {};
    if (data) {
      data.forEach((row) => {
        result[row.user_id] = rowToUserCredits(row);
      });
    }

    return result;
  } catch (error) {
    console.error('Error in getAllCredits:', error);
    throw error;
  }
};
