/**
 * The slice of Stripe Dropisode uses, so tests can use a fake. Shaped after
 * at-cost/glasstrack's billing gateway (MIT). Radar is on by default for every
 * Stripe payment; 3D Secure is requested on every top-up.
 */
import Stripe from "stripe";

export interface CheckoutCompleted {
  kind?: "checkout";
  sessionId: string;
  topupId: string;
  workspaceId: string;
  amountCents: number;
  paymentIntentId: string | null;
  paid: boolean;
}

/** Money taken back after a top-up: a refund, or a card dispute (chargeback). */
export interface PaymentReversal {
  kind: "refund" | "dispute" | "dispute_won";
  /** Stripe's id for the refund total or the dispute, for idempotency. */
  ref: string;
  paymentIntentId: string;
  /** Refunds: the total refunded so far on the charge. Disputes: the disputed amount. */
  amountCents: number;
}

export interface PaymentGateway {
  ensureCustomer(p: { existingId: string | null; workspaceId: string; email: string; name: string }): Promise<string>;
  createTopupCheckout(p: {
    customerId: string;
    amountCents: number;
    workspaceId: string;
    topupId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ id: string; url: string }>;
  /** Stripe's fee in cents, once the balance transaction exists. */
  fetchFee(paymentIntentId: string): Promise<number | null>;
  /** Verifies the signature and returns the completed checkout, or null for events Dropisode ignores. */
  parseWebhook(rawBody: string, signature: string): Promise<CheckoutCompleted | PaymentReversal | null>;
}

export function stripeGateway(secretKey: string, webhookSecret: string): PaymentGateway {
  const stripe = new Stripe(secretKey, { appInfo: { name: "Dropisode" }, maxNetworkRetries: 2 });
  return {
    async ensureCustomer({ existingId, workspaceId, email, name }) {
      if (existingId) return existingId;
      const c = await stripe.customers.create(
        { email, name, metadata: { workspace_id: workspaceId } },
        { idempotencyKey: `customer:${workspaceId}` },
      );
      return c.id;
    },
    async createTopupCheckout(p) {
      const s = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          customer: p.customerId,
          client_reference_id: p.workspaceId,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: p.amountCents,
                product_data: {
                  name: "Dropisode credit",
                  description: "Prepaid credit. Generations cost the provider's price + 20%. Credit never expires.",
                },
              },
            },
          ],
          payment_method_options: { card: { request_three_d_secure: "any" } },
          payment_intent_data: { metadata: { workspace_id: p.workspaceId, topup_id: p.topupId } },
          metadata: { workspace_id: p.workspaceId, topup_id: p.topupId },
          billing_address_collection: "required",
          success_url: p.successUrl,
          cancel_url: p.cancelUrl,
        },
        { idempotencyKey: `topup:${p.topupId}` },
      );
      return { id: s.id, url: s.url! };
    },
    async fetchFee(paymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge.balance_transaction"] });
      const charge = pi.latest_charge as Stripe.Charge | null;
      const bt = charge?.balance_transaction as Stripe.BalanceTransaction | null;
      return bt ? bt.fee : null;
    },
    async parseWebhook(rawBody, signature) {
      const event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
      const pi = (v: string | { id: string } | null | undefined) => (typeof v === "string" ? v : (v?.id ?? ""));
      if (event.type === "charge.refunded") {
        const ch = event.data.object as Stripe.Charge;
        return {
          kind: "refund",
          ref: `${ch.id}:${ch.amount_refunded}`,
          paymentIntentId: pi(ch.payment_intent),
          amountCents: ch.amount_refunded,
        };
      }
      if (event.type === "charge.dispute.created") {
        const d = event.data.object as Stripe.Dispute;
        return { kind: "dispute", ref: d.id, paymentIntentId: pi(d.payment_intent), amountCents: d.amount };
      }
      if (event.type === "charge.dispute.closed") {
        const d = event.data.object as Stripe.Dispute;
        if (d.status !== "won") return null;
        return { kind: "dispute_won", ref: d.id, paymentIntentId: pi(d.payment_intent), amountCents: d.amount };
      }
      if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") return null;
      const s = event.data.object as Stripe.Checkout.Session;
      return {
        sessionId: s.id,
        topupId: s.metadata?.topup_id ?? "",
        workspaceId: s.metadata?.workspace_id ?? "",
        amountCents: s.amount_total ?? 0,
        paymentIntentId: typeof s.payment_intent === "string" ? s.payment_intent : (s.payment_intent?.id ?? null),
        paid: s.payment_status === "paid",
      };
    },
  };
}
