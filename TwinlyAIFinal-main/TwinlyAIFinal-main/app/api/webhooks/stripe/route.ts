import { NextRequest, NextResponse } from "next/server";
import Stripe from "stripe";
import { headers } from "next/headers";
import { initializeCredits, updateCredits, resetCreditsForRenewal } from "@/lib/credits/storage";
import {
  getReferralBySubscriptionId,
  updateReferralStatus,
  updateReferralEarnings,
  createReferral,
  getUserReferralEarnings,
  getUserReferrals,
} from "@/lib/referrals/storage";
import { getTierFromPlanId, getInitialVisionCredits } from "@/lib/tiers/config";

// Force dynamic rendering
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Plan credit limits (in credits, where 1 minute = 3 credits)
const PLAN_CREDITS: Record<string, number> = {
  free_trial: 45,    // 15 minutes
  starter: 180,      // 60 minutes
  pro: 450,          // 150 minutes
  ultra: 600,        // 200 minutes
};

// Initialize Stripe client
let stripe: Stripe | null = null;
let webhookSecret: string | null = null;

try {
  const stripeKey = process.env.STRIPE_SECRET_KEY || process.env.Stripe_Secret_Key;
  if (stripeKey) {
    stripe = new Stripe(stripeKey, {
      apiVersion: "2025-02-24.acacia",
    });
  }
  webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || process.env.Stripe_Webhook_Secret || null;
} catch (error) {
  console.error("Error initializing Stripe:", error);
}

export async function POST(request: NextRequest) {
  try {
    if (!stripe || !webhookSecret) {
      console.error("Stripe client or webhook secret not initialized");
      return NextResponse.json(
        { error: "Stripe webhook not configured" },
        { status: 500 }
      );
    }

    const body = await request.text();
    const headersList = await headers();
    const signature = headersList.get("stripe-signature");

    if (!signature) {
      return NextResponse.json(
        { error: "Missing stripe-signature header" },
        { status: 400 }
      );
    }

    let event: Stripe.Event;

    try {
      event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
    } catch (err: any) {
      console.error("Webhook signature verification failed:", err.message);
      return NextResponse.json(
        { error: `Webhook Error: ${err.message}` },
        { status: 400 }
      );
    }

    console.log(`Received webhook event: ${event.type}`);

    // Handle different event types
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const userId = session.metadata?.userId;
        const planId = session.metadata?.planId;
        const subscriptionId = session.subscription as string | undefined;
        const referralCode = session.metadata?.referralCode;
        const referrerId = session.metadata?.referrerId;

        console.log(`Checkout completed for user ${userId}, plan: ${planId}`);

        if (userId && planId) {
          try {
            const totalCredits = PLAN_CREDITS[planId] || 0;
            if (totalCredits > 0) {
              await initializeCredits(userId, planId, subscriptionId);
              console.log(`Initialized ${totalCredits} credits for user ${userId} on plan ${planId}`);
            }

            // Set vision credits in subscription metadata
            if (subscriptionId) {
              const tier = getTierFromPlanId(planId);
              const visionCredits = getInitialVisionCredits(tier);
              
              await stripe.subscriptions.update(subscriptionId, {
                metadata: {
                  ...session.metadata,
                  vision_credits: visionCredits.toString(),
                },
              });
              console.log(`Set vision credits to ${visionCredits} for subscription ${subscriptionId}`);
            }

            // Process referral commission if applicable
            if (referralCode && referrerId && planId && planId !== "free_trial") {
              // Get subscription to calculate amount
              let subscription: Stripe.Subscription | null = null;
              if (subscriptionId) {
                subscription = await stripe.subscriptions.retrieve(subscriptionId);
              }

              if (subscription) {
                // Calculate commission from subscription amount
                const amount = (subscription.items.data[0]?.price?.unit_amount || 0) / 100; // Convert from cents
                const commission = amount * 0.25; // 25% commission

                // Create referral record
                const referral = createReferral(
                  referrerId,
                  userId,
                  amount,
                  commission,
                  subscriptionId
                );

                // Mark as paid
                updateReferralStatus(referral.id, 'paid');
                updateReferralEarnings(referrerId, commission, 'paid');

                console.log(`Referral commission processed: $${commission.toFixed(2)} for referrer ${referrerId}`);
              }
            }
          } catch (error: any) {
            console.error(`Error processing checkout for user ${userId}:`, error);
            // Don't throw - log the error but don't fail the webhook
          }
        }

        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = subscription.metadata?.userId;
        const planId = subscription.metadata?.planId;

        console.log(`Subscription updated for user ${userId}, plan: ${planId}, status: ${subscription.status}, cancel_at_period_end: ${subscription.cancel_at_period_end}`);

        // Log cancellation if set to cancel at period end
        if (subscription.cancel_at_period_end) {
          console.log(`Subscription ${subscription.id} set to cancel at period end (${new Date(subscription.current_period_end * 1000).toISOString()})`);
        }

        // Update credits if plan changed
        if (userId && planId) {
          try {
            const totalCredits = PLAN_CREDITS[planId] || 0;
            if (totalCredits > 0) {
              // Check if user has credits initialized, if not initialize them
              const { getUserCredits } = await import("@/lib/credits/storage");
              const existingCredits = await getUserCredits(userId);
              
              if (!existingCredits) {
                // User doesn't have credits yet, initialize them
                await initializeCredits(userId, planId, subscription.id);
                console.log(`Initialized ${totalCredits} credits for user ${userId} on plan ${planId}`);
              } else {
                // Check if plan actually changed - if so, reset credits (discard remaining)
                if (existingCredits.planId !== planId) {
                  // Plan changed - reset credits to new plan's full amount
                  await resetCreditsForRenewal(userId, planId);
                  // Update subscription ID
                  await updateCredits(userId, {
                    subscriptionId: subscription.id,
                  });
                  console.log(`Plan changed for user ${userId}: ${existingCredits.planId} → ${planId}. Reset credits to ${totalCredits} (discarded remaining)`);
                } else {
                  // Same plan, just update subscription ID if needed
                  await updateCredits(userId, {
                    subscriptionId: subscription.id,
                  });
                  console.log(`Updated subscription ID for user ${userId} on plan ${planId}`);
                }
              }
            }
          } catch (error: any) {
            console.error(`Error updating credits for user ${userId}:`, error);
            console.error(`Error details:`, {
              message: error?.message,
              stack: error?.stack,
              userId,
              planId,
            });
            // Don't throw - log the error but don't fail the webhook
            // This prevents 500 errors from breaking the webhook
          }
        }

        // TODO: Update subscription status in your database
        // Example:
        // await updateSubscriptionStatus(userId, subscription.status);

        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const userId = subscription.metadata?.userId;

        console.log(`Subscription deleted for user ${userId}`);

        // Note: Credits remain until period end, so we don't delete them here
        // You might want to add logic to mark subscription as cancelled
        // but keep credits active until current_period_end

        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = invoice.subscription as string | undefined;
        
        console.log("Invoice payment succeeded:", invoice.id);
        
        // Process referral commission only if this is the first payment (not recurring)
        // Check if subscription has referral metadata and if referral hasn't been processed yet
        if (subscriptionId) {
          try {
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            const referralCode = subscription.metadata?.referralCode;
            const referrerId = subscription.metadata?.referrerId;
            const planId = subscription.metadata?.planId;
            
            // Only process if:
            // 1. Referral code exists
            // 2. Plan is not free_trial
            // 3. This is the first invoice (billing_reason is 'subscription_create')
            if (referralCode && referrerId && planId && planId !== "free_trial" && invoice.billing_reason === 'subscription_create') {
              // Check if referral already processed
              let referral = getReferralBySubscriptionId(subscriptionId);
              
              if (!referral) {
                // Calculate commission from invoice amount
                const amount = (invoice.amount_paid || 0) / 100; // Convert from cents
                const commission = amount * 0.25;
                
                // Create referral record
                referral = createReferral(
                  referrerId,
                  subscription.metadata?.userId || '',
                  amount,
                  commission,
                  subscriptionId
                );
                
                // Mark as paid
                updateReferralStatus(referral.id, 'paid');
                updateReferralEarnings(referrerId, commission, 'paid');
                
                console.log(`Referral commission processed from invoice: $${commission.toFixed(2)} for referrer ${referrerId}`);
              }
            }

            // Reset credits and vision credits on monthly renewal
            if (invoice.billing_reason === 'subscription_cycle' && planId) {
              const userId = subscription.metadata?.userId;
              
              if (userId) {
                try {
                  // Reset voice credits (discard remaining, reset to full plan amount)
                  await resetCreditsForRenewal(userId, planId);
                  console.log(`Reset voice credits for user ${userId} on plan ${planId} (monthly renewal - discarded remaining credits)`);
                } catch (error) {
                  console.error(`Error resetting credits for user ${userId}:`, error);
                }
              }
              
              // Reset vision credits on monthly renewal (for Standard tier)
              const tier = getTierFromPlanId(planId);
              if (tier === "standard") {
                const visionCredits = getInitialVisionCredits(tier);
                await stripe.subscriptions.update(subscriptionId, {
                  metadata: {
                    ...subscription.metadata,
                    vision_credits: visionCredits.toString(),
                  },
                });
                console.log(`Reset vision credits to ${visionCredits} for subscription ${subscriptionId} (monthly renewal)`);
              }
            }
          } catch (error) {
            console.error("Error processing invoice payment:", error);
          }
        }

        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const subscriptionId = invoice.subscription as string | undefined;
        
        console.log("Invoice payment failed:", invoice.id);
        
        // TODO: Handle payment failure
        // You might want to:
        // - Send email notification to user
        // - Mark subscription as past_due
        // - Restrict access to features
        
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return NextResponse.json({ received: true });
  } catch (error: any) {
    console.error("Webhook error:", error);
    return NextResponse.json(
      { error: error.message || "Webhook handler failed" },
      { status: 500 }
    );
  }
}
