import Stripe from 'stripe';
import { createClerkClient } from '@clerk/clerk-sdk-node';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

// Remplace le lien de connexion "sans code" (billing.stripe.com/p/login/...), qui
// exige que l'utilisateur retape son e-mail et attende un lien magique envoyé par
// Stripe -- lien qui n'arrive jamais tant qu'aucun achat n'a été finalisé (aucun
// client Stripe n'existe alors pour cet e-mail). Ici, l'utilisateur est déjà
// connecté via Clerk : on retrouve directement son client Stripe (enregistré par
// le webhook lors de son premier achat) et on lui ouvre une session de portail
// authentifiée, sans e-mail ni attente.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { userId, returnUrl } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'missing_user_id' });

  try {
    const user = await clerk.users.getUser(userId);
    const customerId = user.publicMetadata?.stripe_customer_id;
    if (!customerId) return res.status(404).json({ error: 'no_stripe_customer' });

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl || 'https://easyscript.site/',
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-portal-session: erreur', err);
    res.status(500).json({ error: 'server_error' });
  }
}
