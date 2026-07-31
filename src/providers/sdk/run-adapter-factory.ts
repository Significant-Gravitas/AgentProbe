import type {
  EndpointAdapterFactory,
  EndpointAdapterFactoryContext,
} from "../../domains/evaluation/ports.ts";
import type { Endpoints } from "../../shared/types/contracts.ts";
import { buildEndpointAdapter } from "./adapters.ts";
import { resolveAuth } from "./autogpt-auth.ts";

export function buildProviderEndpointAdapter(
  endpoint: Endpoints,
  context: EndpointAdapterFactoryContext,
) {
  return buildEndpointAdapter(endpoint, {
    autogptAuthResolver: () =>
      resolveAuth({
        userId: context.userId,
        name: context.userName,
        backendUrl: context.baseUrlOverride?.trim() || undefined,
      }),
  });
}

export const providerEndpointAdapterFactory: EndpointAdapterFactory =
  buildProviderEndpointAdapter;
