import Stripe from 'stripe';
import { createClerkClient } from '@clerk/clerk-sdk-node';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

const SB_URL = 'https://tqvgsqqvyojaoxtdwasz.supabase.co';
const SB_KEY = 'sb_publishable_3B1MXErWXsaYSzlrrO0CFw_-Ugncma_';

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

// Stripe peut délivrer le même événement plusieurs fois (retries réseau, ou un
// simple délai de traitement trop long) -- c'est documenté et attendu, pas un
// bug côté Stripe. Sans garde, chaque redélivrance de "checkout.session.completed"
// réappliquait les crédits une fois de plus : c'est ce qui a transformé un achat de
// 20 crédits en 80 (4 délivrances traitées comme 4 achats séparés). On réclame
// donc l'event.id dans une table dédiée avant tout traitement : la contrainte
// UNIQUE de Postgres garantit qu'une seule délivrance "gagne", quel que soit le
// nombre de fois où Stripe renvoie le même événement, même en cas de délivrances
// concurrentes.
async function claimEvent(eventId, sessionId) {
  const res = await fetch(SB_URL + '/rest/v1/stripe_events_processed', {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ event_id: eventId, session_id: sessionId }),
  });
  if (res.status === 201 || res.status === 204) return true;   // nouvelle ligne insérée : on peut traiter
  if (res.status === 409) return false;                        // déjà traité par une délivrance précédente
  throw new Error(`claimEvent: statut Supabase inattendu ${res.status} - ${await res.text()}`);
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
        const claimed = await claimEvent(event.id, session.id);
        if (!claimed) {
          console.log(`Stripe webhook: événement ${event.id} déjà traité, ignoré (redélivrance Stripe)`);
        } else if (session.mode === 'subscription') {
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
        // Avant l'ajout de claimEvent(), on avalait systématiquement l'erreur ici
        // pour éviter qu'une redélivrance Stripe double-crédite -- mais ça pouvait
        // aussi perdre silencieusement un vrai paiement si Clerk ou Supabase
        // répondait mal une seule fois. Maintenant que claimEvent() rend le
        // traitement idempotent, une redélivrance après un 500 est sans danger :
        // on laisse donc Stripe réessayer au lieu de risquer de perdre le crédit.
        console.error(`Stripe webhook: erreur traitement pour user ${userId}`, err);
        return res.status(500).json({ error: 'processing_failed' });
      }
    }
  }

  res.status(200).json({ received: true });
}
