// deno run --allow-net index.ts
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { decodeBase64, encodeBase64 } from 'jsr:@std/encoding/base64'
import { encodePayloadWithXOR, decodePayloadWithXOR } from '../_shared/vmflow-payload.ts';

function toScaleFactor(p: number, x: number, y: number): number {
  return p / x / Math.pow(10, -y);
}

function fromScaleFactor(p: number, x: number, y: number): number {
  return p * x * Math.pow(10, -y);
}

Deno.serve(async (req) => {

    try {
        const body = await req.json();

        const payload: Uint8Array = decodeBase64(body.payload)

        const supabase = createClient( Deno.env.get("SUPABASE_URL")!, Deno.env.get('SUPABASE_ANON_KEY')!,
            { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
        )

        const { data: embeddedData, error: embeddedError } = await supabase.from("embedded").select("passkey,subdomain,id,machine_id").eq("subdomain", body.subdomain);

        const decodedPayload = decodePayloadWithXOR(embeddedData[0].passkey, payload);

        const itemPrice =
            (decodedPayload[1] << 24) |
            (decodedPayload[2] << 16) |
            (decodedPayload[3] << 8) |
            (decodedPayload[4] << 0);

        const itemNumber = (decodedPayload[5] << 8) | (decodedPayload[6] << 0);

        const { data: saleData, error: salesError } = await supabase.from("sales").insert([{
            embedded_id: embeddedData[0].id,
            machine_id:  embeddedData[0].machine_id ?? null,
            item_number: itemNumber,
            item_price:  fromScaleFactor(itemPrice, 1, 2),
            channel:     "ble",
            lat:         (body.lat !== undefined ? body.lat : null),
            lng:         (body.lng !== undefined ? body.lng : null) }]).select("id").single()

        decodedPayload[0] = 0x03;   // cmd

        const encodedPayload = encodePayloadWithXOR(embeddedData[0].passkey, decodedPayload);

        return new Response(JSON.stringify({payload: encodeBase64(encodedPayload), sales_id: saleData.id}), { headers: { 'Content-Type': 'application/json' } })

    } catch (err) {
        return new Response(JSON.stringify({ message: err?.message ?? err }), {
            headers: { 'Content-Type': 'application/json' },
            status: 500
        })
    }
})
