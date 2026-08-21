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

  // Prix des trois produits vendus via Stripe Payment Links, en centimes.
  const PRICE_CENTS = { pro: 179, pack20: 59, pack40: 69 };

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;

    if (!userId) {
      console.error(`Stripe webhook: session ${session.id} sans client_reference_id`);
    } else {
      try {
        const amount = session.amount_total;
        if (amount === PRICE_CENTS.pro) {
          await clerk.users.updateUserMetadata(userId, {
            publicMetadata: { pro: true },
          });
        } else if (amount === PRICE_CENTS.pack20 || amount === PRICE_CENTS.pack40) {
          const creditsToAdd = amount === PRICE_CENTS.pack20 ? 20 : 40;
          const user = await clerk.users.getUser(userId);
          const currentCreditsAdded = user.publicMetadata?.credits_added || 0;
          await clerk.users.updateUserMetadata(userId, {
            publicMetadata: { credits_added: currentCreditsAdded + creditsToAdd },
          });
        } else {
          console.error(`Stripe webhook: montant inattendu (${amount}) pour la session ${session.id}`);
        }
      } catch (err) {
        // On ne fait jamais échouer le webhook : Stripe le retenterait indéfiniment.
        console.error(`Stripe webhook: erreur mise à jour Clerk pour user ${userId}`, err);
      }
    }
  }

  res.status(200).json({ received: true });
}
