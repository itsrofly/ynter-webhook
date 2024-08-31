import Stripe from "https://esm.sh/stripe@16.5.0?target=deno";
import { createClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@std/dotenv/load";


const stripe = new Stripe(Deno.env.get("STRIPE_API_KEY")!);
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!)
const cryptoProvider = Stripe.createSubtleCryptoProvider();


// Function to convert Unix timestamp to PostgreSQL timestamp format
function PostgresTimestamp(unixTimestamp) {
  if (unixTimestamp == null)
    return null;

  const date = new Date(unixTimestamp * 1000); // Convert seconds to milliseconds

  // Format the date to PostgreSQL timestamp format
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');

  // Construct PostgreSQL timestamp string
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}


Deno.serve({
  onListen() {
    console.log(`Server started 🟩`);
  }
}, async (request) => {
  const signature = request.headers.get("Stripe-Signature");

  if (!signature)
    return new Response(JSON.stringify({ ok: false }), { status: 401 });

  const body = await request.text();
  let event;

  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature!,
      Deno.env.get("STRIPE_WEBHOOK_SIGNING_SECRET")!,
      undefined,
      cryptoProvider
    );
  } catch (error) {
    console.error(error);
    return new Response(error.message, { status: 400 });
  }

  switch (event.type) {
    case 'invoice.payment_succeeded': {
      // Create or update customer
      const Payment = event.data.object;
      const data: any[] = Payment["lines"]["data"];
      const Period = data[data.length - 1]["period"]["end"];

      let response = await supabase
        .from('subscriptions')
        .upsert({
          subscription_id: Payment["subscription"], customer_id: Payment["customer"],
          input_token: 0, expires: PostgresTimestamp(Period)
        },
          { onConflict: 'subscription_id' })

      if (response.error) {
        return new Response(`Error Upsert Subscriptions: ${response.error} 🟥`, { status: 500 });
      }

      response = await supabase
        .from('payments')
        .insert({
          charge_id: Payment["charge"], subscription_id: Payment["subscription"],
          customer_id: Payment["customer"], amount: Payment["total"] / 100,
          currency: Payment["currency"], country: Payment["account_country"],
          customer_email: Payment["customer_email"], customer_name: Payment["customer_name"]
        })

      if (response.error) {
        return new Response(`Error Insert Payments: ${response.error} 🟥`, { status: 500 });
      }

      console.log(`Payment inserted 🟩`);
      break;
    }


    case 'customer.subscription.updated': {
      // Plan switch or cancel at end of period
      const Updated = event.data.object;

      const { error } = await supabase
        .from("subscriptions")
        .update({
          expires: PostgresTimestamp(Updated["cancel_at"] ?? Updated["current_period_end"]),
          cancel_at_period_end: Updated["cancel_at_period_end"] ? 1 : 0
        })
        .eq("subscription_id", Updated["id"])

      if (error) {
        return new Response(`customer.subscription.updated - Error Update Subscriptions: ${error} 🟥`, { status: 500 });
      }

      console.log(`Subscription updated 🟩`);
      break;
    }


    case 'customer.subscription.deleted': {
      // Subscription canceled now
      const Deleted = event.data.object;

      const { error } = await supabase
        .from("subscriptions")
        .update({
          expires: PostgresTimestamp(Deleted["canceled_at"])
        })
        .eq("subscription_id", Deleted["id"])

      if (error) {
        return new Response(`customer.subscription.deleted - Error Update Subscriptions: ${error} 🟥`, { status: 500 });
      }

      console.log(`Subscription canceled 🟩`);
      break;
    }

    // Plan is expiring
    case 'subscription_schedule.expiring':
      console.log("Subscription is expiring")
      break;

    default:
      console.log(`Unhandled event type ${event.type}`);
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
});
