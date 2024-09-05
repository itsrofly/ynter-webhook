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
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Set up the Plaid client library
const plaidConfig = new Configuration({
    basePath: PlaidEnvironments[Deno.env.get("PLAIDENV")!],
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
    url: Deno.env.get("EXCHANGE_REST_URL")!,
    token: Deno.env.get("EXCHANGE_REST_TOKEN")!,
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
        const payload: { token: string, public_token: string } = await request.json();

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
        const customer_id = fetchUser.data[0].customer_id;

        // Extract language and country code from request headers
        const acceptLanguage = request.headers.get("accept-language") || "";
        // Parse the language and country code, e.g., "en-US"
        const [_language, region] = acceptLanguage.split(",")[0].split("-");


        // Exchange Token Data
        const tokenResponse = await plaidClient.itemPublicTokenExchange({
            public_token: payload.public_token,
        });
        const tokenData = tokenResponse.data;

        // Token ID
        const tokens_id = tokenData.item_id;

        // Access Token of the institution session
        const access_token = tokenData.access_token;

        // Get institution id
        const itemResponse = await plaidClient.itemGet({
            access_token: access_token,
        });
        const institution_id = itemResponse.data.item.institution_id;

        // Get institution name
        const institutionResponse = await plaidClient.institutionsGetById({
            institution_id: institution_id,
            country_codes: [region || "US"],
        });
        const institution_name = institutionResponse.data.institution.name;

        //  Insert token to the database if not exist, if exist then update
        const response = await supabase
            .from('tokens')
            .upsert({
                tokens_id: tokens_id,
                customer_id: customer_id,
                access_token: access_token,
                institution_id: institution_id
            },
                {
                    onConflict: ['customer_id', 'institution_id']
                });
        if (response.error) {
            console.log(error);
            return new Response(`Error Insert Token: ${response.error} 🟥`, { status: 500 });
        }
        return new Response(JSON.stringify({ institution_id, institution_name }), { status: 200 });
    } catch (error) {
        console.error(error)
        return new Response(error.message, { status: 500 });
    }
});