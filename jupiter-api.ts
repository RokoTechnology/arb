// jupiter-api.ts - Wrapper for Jupiter API
import { PublicKey } from '@solana/web3.js';

// Interface for Jupiter API
export interface JupiterAPI {
  computeRoutes(params: ComputeRoutesParams): Promise<ComputeRoutesResponse>;
  exchange(params: ExchangeParams): Promise<ExchangeResponse>;
}

// Parameter types
interface ComputeRoutesParams {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: number | string | bigint;
  slippageBps?: number;
  feeBps?: number;
  onlyDirectRoutes?: boolean;
  maxAccounts?: number;
}

interface ExchangeParams {
  routeInfo: any;
  userPublicKey?: PublicKey;
}

// Response types
interface ComputeRoutesResponse {
  routesInfos: RouteInfo[];
  contextSlot?: number;
}

interface RouteInfo {
  outAmount: bigint;
  marketInfos: any[];
  amount: bigint;
  slippageBps: number;
  otherAmountThreshold: bigint;
  swapMode: string;
  priceImpactPct: number;
  [key: string]: any;
}

interface ExchangeResponse {
  txid?: string;
  error?: string;
  [key: string]: any;
}

// Setup Jupiter API with rate limiting
export function setupJupiterAPI(requestsPerSecond = 5): JupiterAPI {
  // Basic rate limiting
  const minInterval = 1000 / requestsPerSecond;
  let lastRequestTime = 0;

  const getRateLimit = async () => {
    const now = Date.now();
    const elapsed = now - lastRequestTime;

    if (elapsed < minInterval) {
      await new Promise(resolve => setTimeout(resolve, minInterval - elapsed));
    }

    lastRequestTime = Date.now();
  };

  // Create Jupiter API instance
  return {
    async computeRoutes(params: ComputeRoutesParams): Promise<ComputeRoutesResponse> {
      await getRateLimit();

      try {
        // Build API URL with query parameters
        const url = new URL('https://quote-api.jup.ag/v6/quote');

        url.searchParams.append('inputMint', params.inputMint.toString());
        url.searchParams.append('outputMint', params.outputMint.toString());
        url.searchParams.append('amount', params.amount.toString());

        if (params.slippageBps !== undefined) {
          url.searchParams.append('slippageBps', params.slippageBps.toString());
        }

        if (params.feeBps !== undefined) {
          url.searchParams.append('feeBps', params.feeBps.toString());
        }

        if (params.onlyDirectRoutes !== undefined) {
          url.searchParams.append('onlyDirectRoutes', params.onlyDirectRoutes.toString());
        }

        if (params.maxAccounts !== undefined) {
          url.searchParams.append('maxAccounts', params.maxAccounts.toString());
        }

        // Make API request
        const response = await fetch(url.toString());

        if (!response.ok) {
          throw new Error(`Jupiter API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        // Handle different possible response structures
        const routes = data.data || data.routes || [];

        if (!Array.isArray(routes)) {
          console.error('Unexpected response format:', data);
          return { routesInfos: [] };
        }

        // Transform API response to expected format
        return {
          routesInfos: routes.map((route: any) => ({
            ...route,
            outAmount: BigInt(route.outAmount || 0),
            amount: BigInt(route.inAmount || route.amount || 0),
            otherAmountThreshold: BigInt(route.otherAmountThreshold || 0),
          })),
          contextSlot: data.contextSlot,
        };
      } catch (error) {
        console.error('Error computing routes:', error);
        return { routesInfos: [] };
      }
    },

    async exchange(params: ExchangeParams): Promise<ExchangeResponse> {
      await getRateLimit();

      try {
        // In a real implementation, this would call the Jupiter swap API
        // For paper trading/simulation, we'll just return a mock response

        // Simulate network latency
        await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));

        // Generate a fake transaction ID
        const txid = 'sim' + Math.random().toString(36).substring(2, 15);

        return { txid };
      } catch (error) {
        console.error('Error executing exchange:', error);
        return { error: (error as Error).message };
      }
    },
  };
}
