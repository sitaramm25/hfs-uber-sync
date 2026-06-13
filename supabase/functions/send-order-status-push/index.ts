import { serve } from "https://deno.land/std@0.224.0/http/server.ts"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!

serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 })
    }

    const { order_id, status } = await req.json()

    if (!order_id || !status) {
      return new Response(
        JSON.stringify({ error: "Missing order_id or status" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      )
    }

    const orderRes = await fetch(
      `${SUPABASE_URL}/rest/v1/orders?id=eq.${order_id}&select=id,customer_id,order_number,total_price,status`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    )

    const orders = await orderRes.json()
    const order = orders?.[0]

    if (!order?.customer_id) {
      return new Response(
        JSON.stringify({ ok: true, message: "No customer_id on order" }),
        { headers: { "Content-Type": "application/json" } }
      )
    }

    const tokenRes = await fetch(
      `${SUPABASE_URL}/rest/v1/customer_push_tokens?customer_id=eq.${order.customer_id}&select=expo_push_token`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    )

    const tokens = await tokenRes.json()

    if (!tokens?.length) {
      return new Response(
        JSON.stringify({ ok: true, message: "No push token found" }),
        { headers: { "Content-Type": "application/json" } }
      )
    }

    const statusText: Record<string, string> = {
      pending: "ご注文を受付しました",
      preparing: "調理を開始しました",
      ready: "商品ができあがりました",
      completed: "ご注文が完了しました",
      cancelled: "ご注文がキャンセルされました",
    }

    const messages = tokens.map((token: any) => ({
      to: token.expo_push_token,
      sound: "default",
      title: "HIGH FIVE SALAD",
      body: statusText[status] ?? "注文ステータスが更新されました",
      data: {
        order_id,
        status,
      },
    }))

    const expoRes = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messages),
    })

    const expoData = await expoRes.json()

    return new Response(JSON.stringify({ ok: true, expoData }), {
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }
})// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

console.log("Hello from Functions!");

// This endpoint uses 'publishable' | 'secret' access, apiKey is required.
// Use publishable for Client-facing, key-validated endpoints
// Use secret for Server-to-server, internal calls
export default {
  fetch: withSupabase({ auth: ["publishable", "secret"] }, async (req, ctx) => {
    // Called by another service with a secret key
    // ctx.supabaseAdmin bypasses RLS — use for privileged operations
    /*
    if (ctx.authMode === "secret") {
      const { user_id } = await req.json();
      const { data } = await ctx.supabaseAdmin.auth.admin.getUserById(user_id);

      return Response.json({
        email: data?.user?.email,
      });
    }
    */

    const { name } = await req.json();

    return Response.json({
      message: `Hello ${name}!`,
    });
  }),
};

/* To invoke locally:

  1. Run `supabase start` (see: https://supabase.com/docs/reference/cli/supabase-start)
  2. Make an HTTP request:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/send-order-status-push' \
    --header 'apiKey: sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' \
    --data '{"name":"Functions"}'

*/
