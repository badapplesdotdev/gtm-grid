/**
 * `CrmClientRegistry` — provider string → the {@link CrmClientApi} that serves
 * it (TRI: crm-sync). The single dispatch point between a binding's stored
 * `provider` column and a concrete client. Unknown providers are a defect
 * (bindings can only be created with a registered provider — see
 * CrmSyncService.create), not a user-facing error.
 */

import { Effect } from "effect";
import { AttioClient } from "./attio-client.js";
import type { CrmClientApi, CrmProvider } from "./crm-client.js";

export class CrmClientRegistry extends Effect.Service<CrmClientRegistry>()("CrmClientRegistry", {
  effect: Effect.gen(function* () {
    const attio = yield* AttioClient;
    const clients: Partial<Record<CrmProvider, CrmClientApi>> = { attio };
    return {
      forProvider: (provider: string): CrmClientApi => {
        const client = clients[provider as CrmProvider];
        if (client === undefined) throw new Error(`No CRM client registered for provider "${provider}"`);
        return client;
      },
    } as const;
  }),
  dependencies: [],
}) {}
