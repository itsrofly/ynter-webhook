import Stripe from "https://esm.sh/stripe@16.5.0?target=deno";
import { createClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@std/dotenv/load";

const stripe = new Stripe(Deno.env.get("STRIPE_API_KEY")!);
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!)

Deno.serve({
  onListen() {
    console.log(`Server started 🟩`);
  }
}, async (request) => {
  const signature = request.headers.get("Authorization");

  try {
    if (signature != Deno.env.get("WEBHOOK_KEY")!)
      return new Response(JSON.stringify({ ok: false }), { status: 401 });
  } catch (error) {
    console.error(error)
    return new Response(error.message, { status: 400 });
  }

  const payload = await request.json();
  const customer = await stripe.customers.create({
    email: payload.record.email
  });

  await supabase
    .from('accounts')
    .update({ customer_id: customer.id })
    .eq('id', payload.record.id)
  console.log( "Customer Created 🟩", payload.record.email, payload.record.id, customer.id)

  return new Response(JSON.stringify({ ok: true }), { status: 200 });
});