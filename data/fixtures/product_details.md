# Gusto Pro: Accountant Affiliate Program & Product Details

## Overview
Gusto Pro is our dedicated platform for accounting, bookkeeping, and payroll consultancy partners. It allows firms to manage multiple clients through a single dashboard, automate payroll runs, and provide advisory services backed by real-time data.

## Core Product Offerings
*   **Simple:** Basic payroll, employee self-service, and automated tax filings.
*   **Plus:** Comprehensive payroll, HR tools, time tracking, and team management.
*   **Premium:** Advanced HR features, dedicated support, and scalable compliance.

## Affiliate Partner Compensation Structure
Affiliates are rewarded for referring new businesses to Gusto. The program utilizes a "Bounty + Recurring" model to incentivize both initial acquisition and long-term retention.

### 1. New Client Bounty
*   **Plus Plan Referral:** $100.00 one-time payment per qualified company.
*   **Premium Plan Referral:** $100.00 one-time payment per qualified company.
*   **Simple Plan Referral:** $50.00 one-time payment per qualified company.
*   *Requirement:* The referred client must complete their first successful payroll run and remain active for at least 31 days.

### 2. Recurring Revenue Share
*   **Ongoing Commission:** 10% of the monthly base subscription fee for the first 12 months of the client's lifecycle.
*   **Payout Frequency:** Monthly, net-30 terms via Stripe Connect.

## Revenue Share Rules & Eligibility
*   **Cookie Duration:** 90-day tracking window. If a prospect clicks an affiliate link and signs up within 90 days, the affiliate receives credit.
*   **Attribution Model:** Last-click attribution.
*   **Qualified Referral:** A company that is not currently an active Gusto customer and has not been a customer in the previous 24 months.
*   **Self-Referrals:** Partners are not eligible for commissions on their own firm's Gusto subscription.

## Refund and Clawback Policy
*   **The 30-Day Rule:** If a referred client cancels their subscription or requests a full refund within the first 30 days of service, the $100 bounty is subject to a full clawback.
*   **Clawback Execution:** Any clawback amounts will be deducted from the affiliate's next scheduled payout. If the balance is insufficient, the amount will be carried forward as a negative balance.
*   **Prorated Refunds:** Recurring revenue share is calculated on the net amount paid by the client. If Gusto issues a partial refund, the affiliate’s 10% share is adjusted accordingly in the following billing cycle.

## Technical Tracking Requirements
*   **UTM Parameters:** All links must include `utm_source=affiliate` and `utm_campaign=[Partner_ID]`.
*   **Stripe Metadata:** All successful conversions must map the `affiliate_id` and `referral_timestamp` into the Stripe Customer object metadata for auditability.
*   **Cross-Device Support:** Tracking is anchored to the email address used during the initial lead capture form on the affiliate landing page.
