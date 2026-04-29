# Guia de Configuração: Pagamentos Stripe na Vending Machine

Este documento explica como configurar o sistema VMFlow para aceitar pagamentos via Stripe em suas máquinas.

---

## 1. Como Funciona o Fluxo de Pagamento
1. **QR Code:** O cliente lê um QR Code na máquina que aponta para `https://vmflow.xyz/pay/[ID-DA-MAQUINA]`.
2. **Valor Aberto:** O cliente insere o valor que deseja adicionar de crédito (ex: R$ 5,00).
3. **Checkout Stripe:** O cliente é redirecionado para o ambiente seguro do Stripe para pagar com Cartão de Crédito, Apple Pay ou Google Pay.
4. **Confirmação:** Assim que o pagamento é aprovado, o Stripe avisa o nosso servidor (via Webhook).
5. **Crédito Instantâneo:** O servidor envia um comando via MQTT para a máquina, liberando o crédito imediatamente para o usuário.

---

## 2. Como criar o QR Code da Máquina
Cada máquina possui um link de pagamento exclusivo. Você deve transformar esse link em um QR Code físico para colar na máquina.

1.  Acesse o Dashboard em **Machines**.
2.  Na tabela de máquinas, localize a coluna **Payment Link**.
3.  Clique no ícone de prancheta (📋) para copiar o link (ex: `https://vmflow.xyz/pay/7ea...`).
4.  Use um gerador de QR Code (como `qr-code-generator.com` ou o próprio Canva) e cole o link copiado.
5.  Imprima o QR Code e cole na máquina em um local visível.

---

## 3. Configurando sua conta Stripe
Para que o dinheiro caia na sua conta, você precisa configurar suas chaves de API no painel do operador.

### Passo A: Obter a Secret Key
1. Acesse o [Stripe Dashboard](https://dashboard.stripe.com/).
2. Vá em **Developers** (Desenvolvedores) > **API Keys**.
3. Localize a **Secret Key** (começa com `sk_live_` ou `sk_test_`).
4. Copie esta chave e cole no campo **Stripe Secret Key** nas configurações do VMFlow.

### Passo B: Configurar o Webhook
O Webhook é o que permite ao Stripe avisar o VMFlow que o pagamento foi feito.
1. No Stripe Dashboard, vá em **Developers** > **Webhooks**.
2. Clique em **Add endpoint**.
3. Em **Endpoint URL**, coloque: `https://supabase.vmflow.xyz/functions/v1/stripe-webhook`
4. Em **Select events to listen to**, selecione apenas: `checkout.session.completed`.
5. Após criar o endpoint, clique em "Reveal" em **Signing secret** (começa com `whsec_`).
6. Copie este código e cole no campo **Stripe Webhook Secret** nas configurações do VMFlow.

---

## 4. Segurança e Credenciais
O sistema foi desenhado para ser **Multi-Operador**:
- Cada operador usa sua própria conta do Stripe.
- As chaves são armazenadas de forma privada e nunca são compartilhadas.
- O sistema usa o `owner_id` para garantir que o pagamento de uma máquina caia na conta correta do dono dela.

---

## 5. Testando o Sistema
Para testar antes de usar em produção:
1. Use as chaves de teste do Stripe (`sk_test_...` e `whsec_...`).
2. Acesse a URL da sua máquina no navegador: `https://vmflow.xyz/pay/[UUID-DA-MAQUINA]`.
3. Realize um pagamento usando os cartões de teste do Stripe.
4. Verifique se a máquina recebe o crédito e se a venda aparece no seu Dashboard.

---
*VMFlow - Soluções Inteligentes para Vending Machines*
