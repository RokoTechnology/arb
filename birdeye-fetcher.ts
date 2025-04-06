// birdeye-fetcher.ts - Fetches token data from Birdeye API
import * as fs from 'fs';
import * as path from 'path';

// Token data interface
export interface TokenData {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  volume24h?: number;
  price?: number;
}

export class BirdeyeFetcher {
  private apiKey: string;
  private cacheDir: string;
  private cacheTime: number;
  private baseUrl = 'https://public-api.birdeye.so';

  constructor(apiKey: string, cacheDir: string, cacheTime: number = 3600000) {
    this.apiKey = apiKey;
    this.cacheDir = cacheDir;
    this.cacheTime = cacheTime;

    // Create cache directory if it doesn't exist
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
  }

  // Fetch top tokens by 24h volume
  async fetchTopTokensByVolume(limit: number = 50): Promise<TokenData[]> {
    const cacheFile = path.join(this.cacheDir, 'top_tokens.json');

    // Check if cache exists and is still valid
    if (fs.existsSync(cacheFile)) {
      const stats = fs.statSync(cacheFile);
      const fileTime = stats.mtime.getTime();
      const currentTime = Date.now();

      if (currentTime - fileTime < this.cacheTime) {
        // Cache is still valid, read from file
        try {
          const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
          console.log(`Using cached token data (${cacheData.length} tokens)`);
          return cacheData;
        } catch (error) {
          console.error('Error reading token cache:', error);
          // Continue to fetch new data if cache read fails
        }
      }
    }

    try {
      // If no API key is provided, return default tokens
      if (!this.apiKey) {
        console.log('No Birdeye API key provided, using default token list');
        return this.getDefaultTokens();
      }

      // Fetch from Birdeye API
      const url = `${this.baseUrl}/defi/token_list_all?sort_by=v24hUSD&sort_type=desc&offset=0&limit=${limit}`;
      const response = await fetch(url, {
        headers: {
          'X-API-KEY': this.apiKey
        }
      });

      if (!response.ok) {
        throw new Error(`Error fetching from Birdeye API: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      if (!data.success || !data.data || !Array.isArray(data.data.tokens)) {
        throw new Error('Invalid response from Birdeye API');
      }

      // Transform to our token data format
      const tokens: TokenData[] = data.data.tokens.map((token: any) => ({
        symbol: token.symbol || 'UNKNOWN',
        name: token.name || 'Unknown Token',
        mint: token.address,
        decimals: token.decimals || 0,
        volume24h: token.v24hUSD || 0,
        price: token.price || 0
      }));

      // Save to cache
      fs.writeFileSync(cacheFile, JSON.stringify(tokens, null, 2));
      console.log(`Fetched and cached ${tokens.length} tokens from Birdeye API`);

      return tokens;
    } catch (error) {
      console.error('Error fetching tokens from Birdeye:', error);
      // Return default tokens as fallback
      return this.getDefaultTokens();
    }
  }

  // Get default token list when API is unavailable
  private getDefaultTokens(): TokenData[] {
    const defaultTokens: TokenData[] = [
      { symbol: 'SOL', name: 'Solana', mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
      { symbol: 'USDC', name: 'USD Coin', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
      { symbol: 'USDT', name: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
      { symbol: 'BONK', name: 'Bonk', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', decimals: 5 },
      { symbol: 'JTO', name: 'Jito', mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', decimals: 9 },
      { symbol: 'JUP', name: 'Jupiter', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', decimals: 6 },
      { symbol: 'PYTH', name: 'Pyth Network', mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', decimals: 6 },
      { symbol: 'RNDR', name: 'Render Token', mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', decimals: 8 },
      { symbol: 'MSOL', name: 'Marinade Staked SOL', mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', decimals: 9 },
      { symbol: 'RAY', name: 'Raydium', mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', decimals: 6 }
    ];

    return defaultTokens;
  }
}
