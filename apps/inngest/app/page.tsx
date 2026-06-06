/**
 * Health/landing page. The app's real surface is its API routes
 * (`/api/inngest`, `/api/webhooks/[token]`); this page just confirms the worker
 * is deployed.
 */
export default function Page() {
  return (
    <main>
      <h1>GTM Grid Webhooks</h1>
      <p>Webhook receiver and durable enrichment worker.</p>
    </main>
  );
}
