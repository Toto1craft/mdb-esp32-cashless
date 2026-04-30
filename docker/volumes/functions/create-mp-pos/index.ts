import { createClient } from 'jsr:@supabase/supabase-js@2'

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { machineId } = await req.json()
    if (!machineId) throw new Error('machineId is required')

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // 1. Get machine + owner
    const { data: machine, error: machineError } = await supabase
      .from('machines')
      .select('name, owner_id')
      .eq('id', machineId)
      .single()

    if (machineError || !machine) throw new Error('Machine not found')

    // 2. Get MP access token
    const { data: cred } = await supabase
      .from('credentials')
      .select('value')
      .eq('owner_id', machine.owner_id)
      .eq('key', 'mp_access_token')
      .maybeSingle()

    if (!cred?.value) throw new Error('Mercado Pago not configured for this operator.')

    const token = cred.value
    const mpHeaders = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    }

    // 3. Get MP user info + cache mp_user_id for webhook routing
    const userRes = await fetch('https://api.mercadopago.com/users/me', { headers: mpHeaders })
    if (!userRes.ok) throw new Error('Invalid Mercado Pago access token.')
    const mpUser = await userRes.json()

    await supabase
      .from('credentials')
      .upsert(
        { owner_id: machine.owner_id, key: 'mp_user_id', value: String(mpUser.id) },
        { onConflict: 'owner_id,key' }
      )

    // 4. Get or create store for this operator
    let storeId: number
    const { data: storeCred } = await supabase
      .from('credentials')
      .select('value')
      .eq('owner_id', machine.owner_id)
      .eq('key', 'mp_store_id')
      .maybeSingle()

    if (storeCred?.value) {
      storeId = parseInt(storeCred.value)
    } else {
      const storeRes = await fetch(
        `https://api.mercadopago.com/users/${mpUser.id}/stores`,
        {
          method: 'POST',
          headers: mpHeaders,
          body: JSON.stringify({ name: 'VMFlow', external_id: machine.owner_id }),
        }
      )
      const store = await storeRes.json()
      if (!storeRes.ok) throw new Error(`Failed to create MP store: ${store.message}`)
      storeId = store.id
      await supabase
        .from('credentials')
        .upsert(
          { owner_id: machine.owner_id, key: 'mp_store_id', value: String(storeId) },
          { onConflict: 'owner_id,key' }
        )
    }

    // 5. Get or create POS for this machine (idempotent via external_id)
    const listRes = await fetch(
      `https://api.mercadopago.com/pos?store_id=${storeId}&limit=50`,
      { headers: mpHeaders }
    )
    const list = await listRes.json()
    const existing = list.results?.find((p: any) => p.external_id === machineId)

    let pos: any
    if (existing) {
      const posRes = await fetch(`https://api.mercadopago.com/pos/${existing.id}`, { headers: mpHeaders })
      pos = await posRes.json()
    } else {
      const posRes = await fetch('https://api.mercadopago.com/pos', {
        method: 'POST',
        headers: mpHeaders,
        body: JSON.stringify({
          name: machine.name,
          store_id: storeId,
          external_id: machineId,
          fixed_amount: false,
        }),
      })
      pos = await posRes.json()
      if (!posRes.ok) throw new Error(`Failed to create MP POS: ${pos.message}`)
    }

    return new Response(
      JSON.stringify({
        pos_id: pos.id,
        qr_image: pos.qr?.image ?? null,
        qr_template: pos.qr?.template_image ?? null,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
