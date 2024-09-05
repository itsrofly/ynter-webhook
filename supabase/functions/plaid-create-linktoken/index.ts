// Basics for env and supabase
import "jsr:@std/dotenv/load";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { Ratelimit } from "https://cdn.skypack.dev/@upstash/ratelimit@2.0.2";
import { Redis } from "https://esm.sh/@upstash/redis@1.34.0";

// Plaid
import { Configuration, PlaidEnvironments, PlaidApi } from "https://esm.sh/plaid@26.0.0?target=deno";

// Set up supabase client
const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!
);

// Set up the Plaid client library
const plaidConfig = new Configuration({
    basePath: PlaidEnvironments[Deno.env.get("PLAIDENV")!], // production || sandbox
    baseOptions: {
        headers: {
            'PLAID-CLIENT-ID': Deno.env.get("PLAID_CLIENT_ID")!,
            'PLAID-SECRET': Deno.env.get("PLAID_SECRET")!,
        },
    },
});
const plaidClient = new PlaidApi(plaidConfig);


// Setup Redis
const redis = new Redis({
    url: Deno.env.get("LINKTOKEN_REST_URL")!,
    token: Deno.env.get("LINKTOKEN_REST_TOKEN")!,
});

Deno.serve({
    onListen() {
        console.log(`Server started 🟩 Env:`, Deno.env.get("PLAIDENV")!);
    }
}, async (request) => {
    if (request.method === 'OPTIONS') {
        return new Response('ok', { status: 200 })
    }
    
    try {
        // Api Post Data
        const payload: { token: string, institution_id?: string } = await request.json();

        // Check if user token is valid
        const { data: { user }, error } = await supabase.auth.getUser(payload.token);
        if (error | !user)
            return new Response("No Session Found token:"
                + payload.token, { status: 401 });

        // Create a new ratelimiter, that allows 1 requests per 60 minutes
        const ratelimit = new Ratelimit({
            redis,
            limiter: Ratelimit.slidingWindow(10, "720 m"),
            analytics: true,
        });

        const identifier = user.id;
        const { success } = await ratelimit.limit(identifier);

        if (!success) {
            return new Response("Limit exceeded", { status: 429 });
        }

        // Fetch user data
        const fetchUser = await supabase.from("accounts").select("customer_id").eq('id', user.id);

        // Check if user is premium
        const now = new Date().toISOString()
        const fetchSubs = await supabase
            .from("subscriptions")
            .select()
            .eq('customer_id', fetchUser.data[0].customer_id as string)
            .gte('expires', now);

        if (fetchSubs.error || !fetchSubs.data || !(fetchSubs.data[0])) return new Response("No Subscription Found User:"
            + user.id, { status: 402 });


        // Fetch the latest plaid access token
        let fetchToken;
        let bankData;
        if (payload.institution_id) {
            // If institution then get institution data
            fetchToken = await supabase
                .from("tokens")
                .select()
                .eq('customer_id', fetchUser.data[0].customer_id as string)
                .eq('institution_id', payload.institution_id);
            bankData = fetchToken.data[0];
        } else {
            // if not then fetchToken only to see the number of institutions
            fetchToken = await supabase
                .from("tokens")
                .select()
                .eq('customer_id', fetchUser.data[0].customer_id as string);

            // Limit of institution is five, this prevent for creating more
            if (fetchToken.data.length >= 5) {
                return new Response("Limit exceeded", { status: 429 });
            }
        }

        // Extract language and country code from request headers
        const acceptLanguage = request.headers.get("accept-language") || "";
        // Parse the language and country code, e.g., "en-US"
        const [language, region] = acceptLanguage.split(",")[0].split("-");

        // Construct the linkTokenCreate request object
        const linkTokenCreateRequest: any = {
            user: { client_user_id: user.id },
            products: ["transactions"],
            client_name: "Ynter",
            language: language || "en", // Default to 'en' if not available
            country_codes: [region || "US"] // Default to 'US' if not available
        };

        const linkTokenResponse: any = {};

        // Conditionally add access_token if it exists institution data
        if (bankData && bankData.access_token) {
            linkTokenCreateRequest.access_token = bankData.access_token;
            linkTokenResponse.access_token = bankData.access_token;
        }

        // Use the constructed request object
        const tokenResponse = await plaidClient.linkTokenCreate(linkTokenCreateRequest);
        // Add link Token to be used if not access_token
        linkTokenResponse.link_token = tokenResponse.data.link_token;
        return new Response(JSON.stringify(linkTokenResponse), { status: 200 });
    } catch (error) {
        console.error(error)
        return new Response(error.message, { status: 500 });
    }
});