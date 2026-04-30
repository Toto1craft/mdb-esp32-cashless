<template>
  <div class="min-h-screen bg-gray-100 flex items-center justify-center p-4">
    <div class="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden">
      <div class="bg-[#009ee3] p-6 text-center">
        <h1 class="text-white text-2xl font-bold">{{ machineName || 'Vending Machine' }}</h1>
        <p class="text-blue-100 text-sm mt-1">Ready to receive credit</p>
      </div>

      <div class="p-8 space-y-6">
        <div v-if="loadingMachine" class="text-center py-10">
          <div class="animate-spin rounded-full h-10 w-10 border-b-2 border-[#009ee3] mx-auto"></div>
          <p class="mt-4 text-gray-500 font-medium">Loading machine details...</p>
        </div>

        <div v-else-if="machineError" class="text-center py-10">
          <div class="text-red-500 text-5xl mb-4">⚠️</div>
          <p class="text-gray-700 font-medium">{{ machineError }}</p>
          <button @click="reload" class="mt-4 text-blue-600 underline">Try again</button>
        </div>

        <div v-else-if="paymentSuccess" class="text-center py-10">
          <div class="text-green-500 text-6xl mb-4">✓</div>
          <p class="text-gray-800 text-lg font-bold">Payment successful!</p>
          <p class="text-gray-500 text-sm mt-2">Credit is being sent to the machine.</p>
          <button @click="resetSuccess" class="mt-6 w-full bg-[#009ee3] hover:bg-[#0088cc] text-white font-bold py-3 rounded-xl transition-all">
            Add more credit
          </button>
        </div>

        <div v-else-if="paymentCanceled" class="text-center py-10">
          <div class="text-yellow-500 text-5xl mb-4">✕</div>
          <p class="text-gray-700 font-medium">Payment canceled.</p>
          <button @click="resetCanceled" class="mt-4 text-blue-600 underline">Try again</button>
        </div>

        <div v-else class="space-y-6">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">
              Enter amount to pay
            </label>
            <div class="relative">
              <span class="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 font-bold text-xl">R$</span>
              <input
                v-model="amount"
                type="number"
                step="0.01"
                min="1"
                class="w-full pl-14 pr-4 py-4 border-2 border-gray-200 rounded-xl text-2xl font-bold focus:border-[#009ee3] focus:ring-0 transition-colors"
                placeholder="0,00"
              />
            </div>
            <p class="text-xs text-gray-400 mt-2">Minimum amount: R$ 1.00</p>
          </div>

          <button
            @click="handlePayment"
            :disabled="paying || !amount || amount < 1"
            class="w-full bg-[#009ee3] hover:bg-[#0088cc] text-white font-bold py-4 rounded-xl shadow-lg transform active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-3"
          >
            <span v-if="paying">
              <svg class="animate-spin h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            </span>
            <span v-else>Pay with Mercado Pago</span>
          </button>

          <div class="flex items-center justify-center pt-4 border-t border-gray-100">
            <svg height="20" viewBox="0 0 192 42" fill="none" xmlns="http://www.w3.org/2000/svg" class="opacity-40">
              <text y="32" font-size="28" font-family="Arial" font-weight="bold" fill="#009ee3">mercadopago</text>
            </svg>
          </div>
        </div>
      </div>

      <div class="bg-gray-50 px-8 py-4 text-center">
        <p class="text-xs text-gray-400">
          Powered by <strong>VMFlow</strong>. Your payment is secure and encrypted.
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { supabase } from '@/lib/supabase'

const route = useRoute()
const router = useRouter()
const machineId = route.params.machineId

const amount = ref('')
const machineName = ref('')
const loadingMachine = ref(true)
const machineError = ref('')
const paying = ref(false)
const paymentSuccess = ref(false)
const paymentCanceled = ref(false)

function reload() {
  window.location.reload()
}

function resetSuccess() {
  router.replace({ query: {} })
  paymentSuccess.value = false
}

function resetCanceled() {
  router.replace({ query: {} })
  paymentCanceled.value = false
}

async function fetchMachine() {
  try {
    const { data, error } = await supabase
      .from('machines')
      .select('name')
      .eq('id', machineId)
      .single()

    if (error) throw error
    if (data) machineName.value = data.name
  } catch (err) {
    console.error('Error fetching machine:', err)
    machineError.value = 'Machine not found or unavailable.'
  } finally {
    loadingMachine.value = false
  }
}

async function handlePayment() {
  if (paying.value) return
  paying.value = true

  try {
    const { data, error } = await supabase.functions.invoke('create-checkout-mp', {
      body: {
        machineId,
        amount: parseFloat(amount.value)
      }
    })

    if (error) throw error

    if (data?.url) {
      window.location.href = data.url
    } else {
      throw new Error('Failed to create payment session.')
    }
  } catch (err) {
    let message = err.message || 'Please try again.'
    if (err.context) {
      try {
        const body = await err.context.json()
        if (body?.error) message = body.error
      } catch {}
    }
    alert('Payment error: ' + message)
    paying.value = false
  }
}

onMounted(() => {
  if (route.query.success === 'true') {
    paymentSuccess.value = true
  } else if (route.query.canceled === 'true') {
    paymentCanceled.value = true
  }
  fetchMachine()
})
</script>
