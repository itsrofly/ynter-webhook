import "jsr:@std/dotenv/load";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Ratelimit } from "https://cdn.skypack.dev/@upstash/ratelimit@2.0.2";
import { Redis } from "https://esm.sh/@upstash/redis@1.34.0";


const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

interface Api {
  token: string,
  merchant: string,
  region: string
}

// Setup Redis
const redis = new Redis({
  url: Deno.env.get("RECEIPT_SEARCH_URL")!,
  token: Deno.env.get("RECEIPT_SEARCH_TOKEN")!,
});


Deno.serve({
  onListen() {
    console.log(`Server started 🟩`);
  }
}, async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { status: 200 })
  }

  try {
    // Api Post Data
    const payload: Api = await request.json();

    // Check if user token is valid
    const { data: { user }, error } = await supabase.auth.getUser(payload.token);
    if (error | !user) return new Response("No Session Found token:"
      + payload.token, { status: 401 });

    // Create a new ratelimiter that allows 50 requests per 43200 minutes (approximately 30 days)
    const ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(50, "43200 m"), // 50 requests per 30 days
      analytics: true,
    });

    const identifier = user.id;
    const { success } = await ratelimit.limit(identifier);

    if (!success) {
      return new Response("Limit exceeded", { status: 429 });
    }


    // Fetch user data
    const fetchUser = await supabase.from("accounts").select("customer_id").eq('id', user.id);

    // Fetch active subscription
    const now = new Date().toISOString()
    const fetchSubs = await supabase
      .from("subscriptions")
      .select()
      .eq('customer_id', fetchUser.data[0].customer_id as string)
      .gte('expires', now);

    if (fetchSubs.error || !fetchSubs.data || !(fetchSubs.data[0])) return new Response("No Subscription Found User:"
      + user.id, { status: 402 });

    // Define the fields you want to retrieve
    const fields = [
      'places.displayName', // Name of the place
      'places.websiteUri', // Website URL
      'places.internationalPhoneNumber', // International phone number
      'places.formattedAddress', // Formatted address
      'places.rating', // Business Ratings
      'places.businessStatus', // Business Status
      'places.primaryType', // Category
      'places.googleMapsUri' // Google maps url
    ]

    // Define the request body
    const requestBody = {
      textQuery: payload.merchant + payload.region
    }
    // Google Maps API
    const url = 'https://places.googleapis.com/v1/places:searchText'
    // Headers
    const headers = {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': Deno.env.get("FINDPLACE_KEY")!,
      'X-Goog-FieldMask': fields.join(',')
    }

    // Fetch data
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(requestBody)
    })
    if (response.ok) {
      return new Response(JSON.stringify(await response.json()), { status: 200 });
    }
    console.error(response.status, response.statusText)
    return new Response(response.statusText, { status: 500 });
  } catch (error) {
    console.error(error)
    return new Response(error.message, { status: 500 });
  }
});
