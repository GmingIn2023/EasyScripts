import Stripe from 'stripe';
import { createClerkClient } from '@clerk/clerk-sdk-node';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

// Le body doit rester brut (non parsé) pour que la vérification de signature Stripe fonctionne
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;

    if (userId) {
      // Payment Links : l'abonnement Pro crée une session mode=subscription,
      // le pack crédits (achat unique) une session mode=payment.
      if (session.mode === 'subscription') {
        await clerk.users.updateUserMetadata(userId, {
          publicMetadata: { pro: true },
        });
      } else {
        const user = await clerk.users.getUser(userId);
        const currentCreditsAdded = user.publicMetadata?.credits_added || 0;
        await clerk.users.updateUserMetadata(userId, {
          publicMetadata: { credits_added: currentCreditsAdded + 40 },
        });
      }
    }
  }

  res.status(200).json({ received: true });
}
