import { createClient } from 'jsr:@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14.25.0?target=deno'
import { Client } from 'https://deno.land/x/mqtt/deno/mod.ts'

Deno.serve(async (req) => {
  const signature = req.headers.get('stripe-signature')

  if (!signature) {
    return new Response('No signature', { status: 400 })
  }

  try {
    const body = await req.text()
    const payload = JSON.parse(body)
    const operatorId = payload.data.object.metadata.operatorId

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 1. Get operator's Stripe Webhook Secret
    const { data: credential, error: credError } = await supabase
      .from('credentials')
      .select('value')
      .eq('owner_id', operatorId)
      .eq('key', 'stripe_webhook_secret')
      .maybeSingle()

    if (credError || !credential) {
      throw new Error('Webhook secret not found for operator')
    }

    // 2. Get operator's Stripe Secret Key (to initialize Stripe object)
    const { data: secretCred } = await supabase
      .from('credentials')
      .select('value')
      .eq('owner_id', operatorId)
      .eq('key', 'stripe_secret_key')
      .maybeSingle()

    const stripe = new Stripe(secretCred.value, {
      apiVersion: '2023-10-16',
      httpClient: Stripe.createFetchHttpClient(),
    })

    // 3. Verify event
    const event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      credential.value
    )

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object
      const machineId = session.metadata.machineId
      const amount = session.amount_total / 100

      // 4. Grant Credit
      // Get machine embedded data
      const { data: embeddedData } = await supabase
        .from('embedded')
        .select('passkey, subdomain, id, status')
        .eq('machine_id', machineId)
        .single()

      if (embeddedData) {
        const cipher: number[] = [...embeddedData.passkey].map((c) => c.charCodeAt(0))
        const payload: Uint8Array = new Uint8Array(19)
        crypto.getRandomValues(payload)

        const itemPrice = amount * 100 // Scale factor 10^-2

        const timestampSec = Math.floor(new Date().getTime() / 1000)

        payload[0] = 0x20 // Command for credit
        payload[1] = (itemPrice >> 24) & 0xff
        payload[2] = (itemPrice >> 16) & 0xff
        payload[3] = (itemPrice >> 8) & 0xff
        payload[4] = (itemPrice >> 0) & 0xff
        payload[5] = 0x00 // itemNumber
        payload[6] = 0x00
        payload[7] = (timestampSec >> 24) & 0xff
        payload[8] = (timestampSec >> 16) & 0xff
        payload[9] = (timestampSec >> 8) & 0xff
        payload[10] = (timestampSec >> 0) & 0xff

        let chk = payload.slice(0, -1).reduce((acc, val) => acc + val, 0)
        payload[payload.length - 1] = chk

        for (let k = 0; k < cipher.length; k++) {
          payload[k + 1] ^= cipher[k]
        }

        // Connect to MQTT
        const client = new Client({ url: `mqtt://mqtt.vmflow.xyz` })
        await client.connect()
        await client.publish(`${embeddedData.subdomain}.vmflow.xyz/credit`, payload)
        await client.disconnect()

        // 5. Record sale
        await supabase.from('sales').insert([
          {
            embedded_id: embeddedData.id,
            machine_id: machineId,
            item_price: amount,
            channel: 'mqtt',
            owner_id: operatorId,
          },
        ])
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (err) {
    console.error(`Error processing webhook: ${err.message}`)
    return new Response(`Webhook Error: ${err.message}`, { status: 400 })
  }
})
