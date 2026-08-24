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

  // Prix des deux packs one-shot, en centimes. Le Pro n'est plus identifié par
  // montant : avec l'essai gratuit de 14 jours sur le Payment Link Pro, Stripe
  // facture 0€ à la création de l'abonnement (amount_total === 0), donc un
  // matching par montant ne détecterait jamais un nouvel abonné Pro.
  const PRICE_CENTS = { pack20: 59, pack40: 69 };

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.client_reference_id;

    if (!userId) {
      console.error(`Stripe webhook: session ${session.id} sans client_reference_id`);
    } else {
      try {
        if (session.mode === 'subscription') {
          // Seul le plan Pro est vendu en abonnement : pas d'ambiguïté à lever
          // par montant, et ça reste valable avec ou sans période d'essai.
          // stripe_customer_id est indispensable pour "Gérer mon abonnement" côté
          // client : sans lui, impossible de créer une session de portail de
          // facturation authentifiée pour cet utilisateur.
          await clerk.users.updateUserMetadata(userId, {
            publicMetadata: { pro: true, stripe_customer_id: session.customer },
          });
        } else {
          const amount = session.amount_total;
          if (amount === PRICE_CENTS.pack20 || amount === PRICE_CENTS.pack40) {
            const creditsToAdd = amount === PRICE_CENTS.pack20 ? 20 : 40;
            const user = await clerk.users.getUser(userId);
            const currentCreditsAdded = user.publicMetadata?.credits_added || 0;
            await clerk.users.updateUserMetadata(userId, {
              publicMetadata: { credits_added: currentCreditsAdded + creditsToAdd, stripe_customer_id: session.customer },
            });
          } else {
            console.error(`Stripe webhook: montant inattendu (${amount}) pour la session ${session.id}`);
          }
        }
      } catch (err) {
        // On ne fait jamais échouer le webhook : Stripe le retenterait indéfiniment.
        console.error(`Stripe webhook: erreur mise à jour Clerk pour user ${userId}`, err);
      }
    }
  }

  res.status(200).json({ received: true });
}
