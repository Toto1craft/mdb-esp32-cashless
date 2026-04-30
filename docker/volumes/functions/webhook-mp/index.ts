import { createClient } from 'jsr:@supabase/supabase-js@2'
import { Client } from 'https://deno.land/x/mqtt/deno/mod.ts'
import { encodePayloadWithXOR } from '../_shared/vmflow-payload.ts'

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url)
    let topic    = url.searchParams.get('topic') ?? url.searchParams.get('type')
    let paymentId = url.searchParams.get('id')
    let mpUserId  = url.searchParams.get('user_id')

    // Newer IPN format sends JSON body
    if (req.method === 'POST') {
      try {
        const body = await req.clone().json()
        topic     = topic     ?? body.type ?? body.topic
        paymentId = paymentId ?? body.data?.id
        mpUserId  = mpUserId  ?? String(body.user_id ?? '')
      } catch { /* query params already set */ }
    }

    if (topic !== 'payment') {
      return new Response(JSON.stringify({ received: true }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    if (!paymentId) throw new Error('Missing payment id in notification')

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // 1. Find operator access token via cached mp_user_id (fast path)
    let accessToken: string | null = null
    let operatorId: string | null = null

    if (mpUserId) {
      const { data: userIdCred } = await supabase
        .from('credentials')
        .select('owner_id')
        .eq('key', 'mp_user_id')
        .eq('value', mpUserId)
        .maybeSingle()

      if (userIdCred) {
        const { data: tokenCred } = await supabase
          .from('credentials')
          .select('value')
          .eq('owner_id', userIdCred.owner_id)
          .eq('key', 'mp_access_token')
          .maybeSingle()
        if (tokenCred) {
          accessToken = tokenCred.value
          operatorId = userIdCred.owner_id
        }
      }
    }

    // Slow fallback: try all tokens
    if (!accessToken) {
      const { data: allCreds } = await supabase
        .from('credentials')
        .select('owner_id, value')
        .eq('key', 'mp_access_token')

      for (const c of allCreds ?? []) {
        const res = await fetch('https://api.mercadopago.com/users/me', {
          headers: { Authorization: `Bearer ${c.value}` },
        })
        if (res.ok) {
          const user = await res.json()
          if (!mpUserId || String(user.id) === String(mpUserId)) {
            accessToken = c.value
            operatorId = c.owner_id
            if (mpUserId) {
              await supabase.from('credentials').upsert(
                { owner_id: c.owner_id, key: 'mp_user_id', value: mpUserId },
                { onConflict: 'owner_id,key' }
              )
            }
            break
          }
        }
      }
    }

    if (!accessToken || !operatorId) throw new Error('No matching operator for MP notification')

    // 2. Fetch payment from MP
    const paymentRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!paymentRes.ok) throw new Error('Failed to fetch payment')
    const payment = await paymentRes.json()

    if (payment.status !== 'approved') {
      return new Response(JSON.stringify({ received: true }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // 3. Extract machineId from external_reference (format: "machineId|ownerId")
    const extRef = payment.external_reference ?? ''
    const machineId = extRef.split('|')[0]
    if (!machineId) throw new Error('No machineId in payment external_reference')

    const totalAmount = payment.transaction_amount ?? 0
    if (totalAmount <= 0) {
      return new Response(JSON.stringify({ received: true }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // 4. Get device for this machine
    const { data: embeddedData } = await supabase
      .from('embedded')
      .select('passkey, subdomain, id, status')
      .eq('machine_id', machineId)
      .single()

    if (!embeddedData) throw new Error('No device linked to this machine')

    // 5. Build and send MQTT credit payload
    const payload = new Uint8Array(19)
    crypto.getRandomValues(payload)

    const itemPrice    = Math.round(totalAmount * 100)
    const timestampSec = Math.floor(Date.now() / 1000)

    payload[0]  = 0x20
    payload[1]  = (itemPrice >> 24) & 0xff
    payload[2]  = (itemPrice >> 16) & 0xff
    payload[3]  = (itemPrice >> 8)  & 0xff
    payload[4]  = (itemPrice >> 0)  & 0xff
    payload[5]  = 0x00
    payload[6]  = 0x00
    payload[7]  = (timestampSec >> 24) & 0xff
    payload[8]  = (timestampSec >> 16) & 0xff
    payload[9]  = (timestampSec >> 8)  & 0xff
    payload[10] = (timestampSec >> 0)  & 0xff

    const encodedPayload = encodePayloadWithXOR(embeddedData.passkey, payload)

    const client = new Client({ url: 'mqtt://mqtt.vmflow.xyz' })
    await client.connect()
    await client.publish(`${embeddedData.subdomain}.vmflow.xyz/credit`, encodedPayload)
    await client.disconnect()

    // 6. Record sale
    await supabase.from('sales').insert([{
      embedded_id: embeddedData.id,
      machine_id:  machineId,
      item_price:  totalAmount,
      channel:     'mqtt',
      owner_id:    operatorId,
    }])

    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (err) {
    console.error(`MP webhook error: ${err.message}`)
    return new Response(`Webhook Error: ${err.message}`, { status: 400 })
  }
})
