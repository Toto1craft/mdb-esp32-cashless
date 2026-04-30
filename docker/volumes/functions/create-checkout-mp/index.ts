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
    const { machineId, amount } = await req.json()
    if (!machineId || !amount) throw new Error('machineId and amount are required')

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

    if (!cred?.value) throw new Error('Mercado Libre not configured for this operator.')

    const origin = req.headers.get('origin') ?? 'https://vmflow.xyz'

    // 3. Create Checkout Pro preference
    const prefRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cred.value}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{
          title: `Credit for ${machine.name}`,
          quantity: 1,
          unit_price: parseFloat(amount),
          currency_id: 'BRL',
        }],
        external_reference: `${machineId}|${machine.owner_id}`,
        back_urls: {
          success: `${origin}/pay/ml/${machineId}?success=true`,
          failure: `${origin}/pay/ml/${machineId}?canceled=true`,
          pending: `${origin}/pay/ml/${machineId}`,
        },
        auto_return: 'approved',
        notification_url: `${Deno.env.get('SUPABASE_URL')}/functions/v1/webhook-mp`,
      }),
    })

    const pref = await prefRes.json()
    if (!prefRes.ok) throw new Error(`ML preference error: ${pref.message}`)

    return new Response(
      JSON.stringify({ url: pref.init_point }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    )
  }
})
