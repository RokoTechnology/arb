// jupiter-api.ts - Fixed Jupiter API wrapper with better error handling

import { PublicKey } from '@solana/web3.js';
import { config } from './config';

// Interface for Jupiter API parameters
export interface JupiterRouteParams {
  inputMint: PublicKey;
  outputMint: PublicKey;
  amount: number;
  slippageBps?: number;
  feeBps?: number;
  onlyDirectRoutes?: boolean;
}

// Interface for Jupiter Exchange parameters
export interface JupiterExchangeParams {
  userPublicKey?: string;
  routeInfo: any;
}

// Jupiter API wrapper
export interface JupiterAPI {
  computeRoutes(params: JupiterRouteParams): Promise<any>;
  exchange(params: JupiterExchangeParams): Promise<any>;
  getQuote(params: JupiterRouteParams): Promise<any>;
}

// Set up the Jupiter API
export function setupJupiterAPI(requestsPerSecond: number = 1): JupiterAPI {
  // Base Jupiter API V6 URL
  const jupiterBaseUrl = 'https://quote-api.jup.ag/v6';

  // Track request timestamps to implement rate limiting
  const requestHistory: number[] = [];
  const historyLimit = 100; // How many requests to track in history

  // Function to ensure we don't exceed rate limits
  async function rateLimitRequest() {
    const now = Date.now();

    // Clean old requests from history (older than 1 minute)
    const recentRequests = requestHistory.filter(time => now - time < 60000);
    requestHistory.length = 0;
    requestHistory.push(...recentRequests);

    // Check if we need to throttle
    if (requestHistory.length > 0) {
      const requestsInLastSecond = requestHistory.filter(time => now - time < 1000).length;

      if (requestsInLastSecond >= requestsPerSecond) {
        // Need to wait before making another request
        const oldestInWindow = Math.min(...requestHistory.filter(time => now - time < 1000));
        const timeToWait = 1000 - (now - oldestInWindow) + 100; // Add 100ms buffer

        // Wait the required time
        if (timeToWait > 0) {
          await new Promise(resolve => setTimeout(resolve, timeToWait));
        }
      }
    }

    // Add current request to history
    requestHistory.push(Date.now());

    // Keep history size limited
    if (requestHistory.length > historyLimit) {
      requestHistory.splice(0, requestHistory.length - historyLimit);
    }
  }

  // Implement Jupiter API functions
  return {
    // Compute possible routes
    computeRoutes: async (params: JupiterRouteParams) => {
      try {
        // Apply rate limiting
        await rateLimitRequest();

        // Build API URL with query parameters
        const url = new URL(`${jupiterBaseUrl}/quote`);

        // Add required parameters
        url.searchParams.append('inputMint', params.inputMint.toString());
        url.searchParams.append('outputMint', params.outputMint.toString());
        url.searchParams.append('amount', params.amount.toString());

        // Add optional parameters if provided
        if (params.slippageBps !== undefined) {
          url.searchParams.append('slippageBps', params.slippageBps.toString());
        }

        if (params.feeBps !== undefined) {
          url.searchParams.append('feeBps', params.feeBps.toString());
        }

        if (params.onlyDirectRoutes !== undefined) {
          url.searchParams.append('onlyDirectRoutes', params.onlyDirectRoutes.toString());
        }

        // Add debugging to see the exact URL being requested
        console.debug(`JUPITER API REQUEST: ${url.toString()}`);

        // Make API request with proper timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

        try {
          const response = await fetch(url.toString(), {
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json'
            }
          });

          // Clear timeout since request completed
          clearTimeout(timeoutId);

          if (!response.ok) {
            // Get more detailed error information
            let errorDetail = '';
            try {
              const errorBody = await response.text();
              errorDetail = ` - ${errorBody}`;
            } catch {
              // Ignore error parsing failures
            }

            throw new Error(`Jupiter API error: ${response.status} ${response.statusText}${errorDetail}`);
          }

          // Parse response as JSON
          return await response.json();
        } catch (error: any) {
          // Check if this was a timeout
          if (error.name === 'AbortError') {
            throw new Error('Jupiter API request timed out after 10 seconds');
          }
          throw error;
        }
      } catch (error) {
        console.error('Error computing routes:', error);
        // Return empty route info instead of throwing
        return { routesInfos: [] };
      }
    },

    // Get quote
    getQuote: async (params: JupiterRouteParams) => {
      try {
        // Apply rate limiting
        await rateLimitRequest();

        // Build API URL with query parameters
        const url = new URL(`${jupiterBaseUrl}/quote`);

        // Add required parameters
        url.searchParams.append('inputMint', params.inputMint.toString());
        url.searchParams.append('outputMint', params.outputMint.toString());
        url.searchParams.append('amount', params.amount.toString());

        // Add optional parameters if provided
        if (params.slippageBps !== undefined) {
          url.searchParams.append('slippageBps', params.slippageBps.toString());
        }

        if (params.feeBps !== undefined) {
          url.searchParams.append('feeBps', params.feeBps.toString());
        }

        if (params.onlyDirectRoutes !== undefined) {
          url.searchParams.append('onlyDirectRoutes', params.onlyDirectRoutes.toString());
        }

        // Make API request with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        try {
          const response = await fetch(url.toString(), {
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json'
            }
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            // Get more detailed error information
            let errorDetail = '';
            try {
              const errorBody = await response.text();
              errorDetail = ` - ${errorBody}`;
            } catch {
              // Ignore error parsing failures
            }

            throw new Error(`Jupiter API error: ${response.status} ${response.statusText}${errorDetail}`);
          }

          return await response.json();
        } catch (error: any) {
          if (error.name === 'AbortError') {
            throw new Error('Jupiter API request timed out after 10 seconds');
          }
          throw error;
        }
      } catch (error) {
        console.error('Error getting quote:', error);
        throw error;
      }
    },

    // Exchange tokens
    exchange: async (params: JupiterExchangeParams) => {
      try {
        // Apply rate limiting
        await rateLimitRequest();

        // Build API URL
        const url = new URL(`${jupiterBaseUrl}/swap`);

        // Prepare request body
        const body = {
          userPublicKey: params.userPublicKey,
          route: params.routeInfo,
          computeUnitPriceMicroLamports: 1000 // Set compute unit price for priority
        };

        // Make API request with timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000); // Longer timeout for swaps

        try {
          const response = await fetch(url.toString(), {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            // Get more detailed error information
            let errorDetail = '';
            try {
              const errorBody = await response.text();
              errorDetail = ` - ${errorBody}`;
            } catch {
              // Ignore error parsing failures
            }

            throw new Error(`Jupiter swap API error: ${response.status} ${response.statusText}${errorDetail}`);
          }

          return await response.json();
        } catch (error: any) {
          if (error.name === 'AbortError') {
            throw new Error('Jupiter swap API request timed out after 20 seconds');
          }
          throw error;
        }
      } catch (error) {
        console.error('Error executing exchange:', error);
        throw error;
      }
    }
  };
}
