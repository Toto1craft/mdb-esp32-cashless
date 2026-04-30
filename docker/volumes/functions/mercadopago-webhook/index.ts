import { createClient } from 'jsr:@supabase/supabase-js@2'
import { Client } from 'https://deno.land/x/mqtt/deno/mod.ts'
import { encodePayloadWithXOR } from '../_shared/vmflow-payload.ts'

Deno.serve(async (req) => {
  try {
    // MP sends IPN notifications via query string: ?topic=merchant_order&id=xxx&user_id=yyy
    const url = new URL(req.url)
    const topic   = url.searchParams.get('topic') ?? url.searchParams.get('type')
    const orderId = url.searchParams.get('id')
    const mpUserId = url.searchParams.get('user_id')

    if (topic !== 'merchant_order') {
      return new Response(JSON.stringify({ received: true }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    if (!orderId || !mpUserId) throw new Error('Missing id or user_id in notification')

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // 1. Find operator — fast path via cached mp_user_id
    let accessToken: string | null = null
    let operatorId: string | null = null

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

    // Slow fallback: scan all mp_access_token credentials
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
          if (String(user.id) === String(mpUserId)) {
            accessToken = c.value
            operatorId = c.owner_id
            await supabase
              .from('credentials')
              .upsert(
                { owner_id: c.owner_id, key: 'mp_user_id', value: mpUserId },
                { onConflict: 'owner_id,key' }
              )
            break
          }
        }
      }
    }

    if (!accessToken || !operatorId) throw new Error('No matching operator for MP user ' + mpUserId)

    // 2. Fetch merchant order
    const orderRes = await fetch(`https://api.mercadopago.com/merchant_orders/${orderId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!orderRes.ok) throw new Error('Failed to fetch merchant order')
    const order = await orderRes.json()

    if (order.order_status !== 'closed') {
      return new Response(JSON.stringify({ received: true }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // 3. Get machineId from POS external_id
    const machineId = order.pos?.external_pos_id ?? order.pos?.external_id
    if (!machineId) throw new Error('No machineId in merchant order POS')

    // 4. Sum approved payments
    const totalAmount = (order.payments ?? [])
      .filter((p: any) => p.status === 'approved')
      .reduce((sum: number, p: any) => sum + (p.transaction_amount ?? 0), 0)

    if (totalAmount <= 0) {
      return new Response(JSON.stringify({ received: true }), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })
    }

    // 5. Get device for this machine
    const { data: embeddedData } = await supabase
      .from('embedded')
      .select('passkey, subdomain, id, status')
      .eq('machine_id', machineId)
      .single()

    if (!embeddedData) throw new Error('No device linked to this machine')

    // 6. Build and send MQTT credit payload
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

    // 7. Record sale
    await supabase.from('sales').insert([{
      embedded_id: embeddedData.id,
      machine_id: machineId,
      item_price: totalAmount,
      channel: 'mqtt',
      owner_id: operatorId,
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
