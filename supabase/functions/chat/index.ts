import "jsr:@std/dotenv/load";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { init, Tiktoken } from 'https://esm.sh/@dqbd/tiktoken@1.0.15/lite/init';
import o200k_base from "https://esm.sh/@dqbd/tiktoken@1.0.15/encoders/o200k_base.json" assert { type: "json" };

await init(async (imports) => {
    const req = await fetch(
        "https://esm.sh/@dqbd/tiktoken@1.0.15/lite/tiktoken_bg.wasm"
    );
    return WebAssembly.instantiate(await req.arrayBuffer(), imports);
});

// Load encoder, good for gpt-4o-mini
const encoder = new Tiktoken(
    o200k_base.bpe_ranks,
    o200k_base.special_tokens,
    o200k_base.pat_str
);

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!)

interface Chat {
    args?: any
    content: string,
    name?: "ask_database"
    role: "user" | "system" | "assistant" | "function",
}

interface Api {
    token: string,
    schema: string,
    version: string,
    stream: boolean,
    useTools: boolean,
    messages: Chat[],
}
const model = 'gpt-4o-mini';
const max_tokens_basic = Deno.env.get("MAX_TOKENS_MONTH_BASIC") // 15.000.000 per month - gpt-4o-mini

const tools = (version: string, schema: string) => {
    switch (version) {
        default:
            return ([
                {
                    "type": "function",
                    "function": {
                        "name": "ask_database",
                        "description": `
                         Use this function to answer user questions.
                         Input should be a fully formed SQLite query.            
                        `,
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "query": {
                                    "type": "string",
                                    "description": `
                                    SQL query extracting info to answer the user's question.
                                    SQL should be written using this database schema:
                                    ${schema}
                                    The query should be returned in plain text, not in JSON.
                                    `
                                }
                            },
                            "required": ["query"]
                        }
                    }
                },
            ]);
    }
};

const system_default =
    `
The user is not a developer, he doesn't know what is SQL.
Always send text using Markdown. Send short answers, only longer if the user requests it.
Use the user's data, found in the database to answer the user's questions, the data will be returned to you and use this data to create a better answer.
You're a professional accounting assistant, your job is to give the best recommendations and meet the user's needs.
`

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

        // Load Tool Using version and schema
        const loadedTool = tools(payload.version, payload.schema);

        // Check if user token is valid
        const { data: { user }, error } = await supabase.auth.getUser(payload.token);
        if (error | !user) return new Response("No Session Found token:"
            + payload.token, { status: 401 });

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



        // Get Tokens used by user
        const subscription_id = fetchSubs.data[0].subscription_id;
        const tokensUsed: number = fetchSubs.data[0].input_token;


        // Tool cost - for analytics
        const utilityCost =
            encoder.encode(JSON.stringify(loadedTool)).length +
            encoder.encode(system_default).length
            ;

        // All Chat Messages Cost
        const totalMessagesCost = payload.messages.reduce((totalCost, message) => {
            // Ignore - Encode the role/name and content <|start|>{role/name}\n{content}<|end|>\n
            const messageCost =
                encoder.encode(message.content)
                    .length;

            // Add to the total cost
            return totalCost + messageCost;
        }, 0);

        // Calculate Total Cost - for analytics
        const totalCost = utilityCost + totalMessagesCost;

        // Check max per month
        if (tokensUsed + totalMessagesCost > max_tokens_basic)
            return new Response(JSON.stringify({
                info: "Max month request reached",
                values: { token_used: tokensUsed, total_messages: totalMessagesCost, max: max_tokens_basic },
                code: 1
            }), { status: 429 });

        // Update token used
        const updateUsage = await supabase
            .from("subscriptions")
            .update({
                input_token: tokensUsed + totalMessagesCost
            })
            .eq("subscription_id", subscription_id)

        if (updateUsage.error) {
            console.error(error)
            return new Response(`Error Update Subscriptions 🟥`, { status: 500 });
        }

        // for analytics
        console.log({
            utility_cost: utilityCost,
            chat_cost: totalMessagesCost,
            total_cost: totalCost,
            subscription: subscription_id,
            user: user.id,
            usage_before: tokensUsed,
            usage: tokensUsed + totalMessagesCost
        }, "📜");

        payload.messages.push(
            { role: "system", content: system_default },
        )
        // Handle streaming responses appropriately
        let completionConfig
        if (payload.useTools) {
            completionConfig = {
                model: model,
                messages: payload.messages,
                tools: loadedTool,
                stream: payload.stream,
                max_tokens: 2000,
                temperature: 0
            }
        } else {
            completionConfig = {
                model: model,
                messages: payload.messages,
                stream: payload.stream,
                max_tokens: 2000,
                temperature: 0
            }
        }

        // Reply MinCost "<|im_start|>assistant<|im_sep|>";
        // Respond with the stream
        return fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${Deno.env.get('OPENAI_API_KEY')}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(completionConfig),
        })
    } catch (error) {
        console.error(error)
        return new Response(error.message, { status: 500 });
    }
});