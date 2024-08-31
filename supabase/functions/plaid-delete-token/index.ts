// Basics for env and supabase
import "jsr:@std/dotenv/load";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Plaid
import { Configuration, PlaidEnvironments, PlaidApi } from "https://esm.sh/plaid@26.0.0?target=deno";

// Set up supabase client
const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Set up the Plaid client library
const plaidConfig = new Configuration({
    basePath: PlaidEnvironments.sandbox,
    baseOptions: {
        headers: {
            'PLAID-CLIENT-ID': Deno.env.get("PLAID_CLIENT_ID")!,
            'PLAID-SECRET': Deno.env.get("PLAID_SECRET")!,
        },
    },
});
const plaidClient = new PlaidApi(plaidConfig);

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
        const payload: { token: string, institution_id: string } = await request.json();

        // Check if user token is valid
        const { data: { user }, error } = await supabase.auth.getUser(payload.token);
        if (error | !user)
            return new Response("No Session Found token:"
                + payload.token, { status: 401 });


        // Fetch user data
        const fetchUser = await supabase.from("accounts").select("customer_id").eq('id', user.id);

        // Fetch institution data
        const fetchToken = await supabase
            .from("tokens")
            .select()
            .eq('customer_id', fetchUser.data[0].customer_id as string)
            .eq('institution_id', payload.institution_id);
        const bankData = fetchToken.data[0];

        // If so then delete from plaidClient
        if (bankData && bankData.access_token)
            await plaidClient.itemRemove({
                access_token: bankData.access_token
            });

        // Delete institution data
        const response = await supabase
            .from('tokens')
            .delete()
            .eq('customer_id', fetchUser.data[0].customer_id as string)
            .eq('institution_id', payload.institution_id);

        return new Response("", { status: 200 });
    } catch (error) {
        console.error(error)
        return new Response(error.message, { status: 500 });
    }
});