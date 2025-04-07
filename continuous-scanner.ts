// continuous-scanner.ts - Continuous scanner with token filtering
import { Connection, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { config, ArbConfig } from './config';
import { JupiterAPI } from './jupiter-api';

// Re-export Opportunity interface for compatibility with existing code
export interface Opportunity {
  route: string[];
  routeSymbols: string[];
  startAmount: number;
  endAmount: number;
  profit: number;
  profitPercentage: number;
  timestamp: number;
  steps: any[];
  dexes?: string[];
}

// Route queue item interface
interface RouteQueueItem {
  route: string[];
  pattern: string;
  priority: number;
  lastChecked: number;
}

// Token data interface
interface TokenData {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  verified?: boolean; // Flag for tokens we've verified work with Jupiter
  blacklisted?: boolean; // Flag for tokens that are known not to work
}

// Jupiter supported token list
interface JupiterToken {
  address: string;
  chainId: number;
  decimals: number;
  name: string;
  symbol: string;
  logoURI?: string;
  tags?: string[];
}

export class ContinuousScanner extends EventEmitter {
  private connection: Connection;
  private jupiterApi: JupiterAPI;
  private config: ArbConfig;
  private tokenMap: Map<string, TokenData> = new Map();
  private knownGoodTokens: Set<string> = new Set(); // Tokens we know work
  private blacklistedTokens: Set<string> = new Set(); // Tokens we know don't work
  private stablecoins: Set<string> = new Set();
  private opportunities: Opportunity[] = [];
  private routeQueue: RouteQueueItem[] = [];
  private isScanning: boolean = false;
  private scanInterval: any = null; // Compatible with both Bun and Node
  private tradeSize: number = 1.0; // Default trade size
  private totalRoutesGenerated = 0;
  private totalRoutesScanned = 0;
  private currentlyActiveRequests = 0;
  private maxConcurrentRequests = 1; // Default to 1 request at a time
  private lastOpportunityFound = 0;
  private routeScoreMap = new Map<string, number>(); // Track route success rates
  private requestDelay = 1500; // 1.5 seconds between requests
  private lastScanTime = 0;
  private scanCount = 0;
  private errorCount = 0;
  private consecutiveErrors = 0;
  private backoffDelay = 1500; // Initial delay
  private maxBackoffDelay = 10000; // Maximum backoff delay (10 seconds)
  private tokenScanPromise: Promise<boolean> | null = null;
  private filteredTokens: Set<string> = new Set();
  private tokenMap: Record<string, TokenInfo> = {};
  private liquidityThreshold: number;
  private excludedTokens: Set<string> = new Set();
  private verifiedOnly: boolean;
  private includedTokens: Set<string> = new Set(); // For explicit inclusion
  private sourceToken: string; // Single source token for arbitrage

  constructor(
    connection: Connection,
    jupiterApi: JupiterAPI,
    config: ArbConfig
  ) {
    super();
    this.connection = connection;
    this.jupiterApi = jupiterApi;
    this.config = config;

    // Initialize known stablecoins
    this.initializeStablecoins();

    // Initialize blacklisted tokens from config
    if (config.tokens.tokenBlacklist && Array.isArray(config.tokens.tokenBlacklist)) {
      config.tokens.tokenBlacklist.forEach(token => this.blacklistedTokens.add(token));
    }

    // Calculate optimal request delay to stay under rate limits
    // For 60 req/min, we want a delay of at least 1000ms
    this.requestDelay = Math.ceil(60000 / 40); // 40 req/min to be safe

    // Set max concurrent requests (1 is safest for rate limits)
    this.maxConcurrentRequests = 1;

    this.getLogger().info(`Initialized continuous scanner with ${this.requestDelay}ms delay between requests`);
  }

  // Initialize stablecoins list
  private initializeStablecoins() {
    // Common Solana stablecoins
    const stablecoins = [
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
      'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
      'AFbX8oGjGpmVFywbVouvhQSRmiW2aR1mohfahi4Y2AdB', // GST
      // Add more stablecoins as needed
    ];

    stablecoins.forEach(mint => this.stablecoins.add(mint));
  }

  // Logger for consistent log format
  private getLogger() {
    const logPrefix = this.config.paperTrading.enabled ? 'PAPER' : 'PRODUCTION';
    return {
      debug: (...args: any[]) =>
        this.config.monitoring.logLevel === 'debug' &&
        console.debug(`[${logPrefix}] [${new Date().toISOString()}]`, ...args),
      info: (...args: any[]) =>
        ['debug', 'info'].includes(this.config.monitoring.logLevel) &&
        console.info(`[${logPrefix}] [${new Date().toISOString()}]`, ...args),
      warn: (...args: any[]) =>
        ['debug', 'info', 'warn'].includes(this.config.monitoring.logLevel) &&
        console.warn(`[${logPrefix}] [${new Date().toISOString()}]`, ...args),
      error: (...args: any[]) =>
        console.error(`[${logPrefix}] [${new Date().toISOString()}]`, ...args)
    };
  }

  // Initialize scanner with token map
  async initialize(tokenMap: any): Promise<boolean> {
    const logger = this.getLogger();
    logger.info(`Initializing continuous arbitrage scanner...`);

    // Create report directory if it doesn't exist
    if (!fs.existsSync(this.config.triangleScanner.reportDir)) {
      fs.mkdirSync(this.config.triangleScanner.reportDir, { recursive: true });
    }

    // Initialize known good tokens with our base tokens (typically SOL and stablecoins)
    this.knownGoodTokens.add(this.config.tokens.solMint);
    this.stablecoins.forEach(stablecoin => this.knownGoodTokens.add(stablecoin));

    // Check for cached tradable tokens
    await this.loadTradableTokensCache();

    // Convert token map to our internal format
    for (const [address, token] of Object.entries(tokenMap)) {
      if (token && typeof token === 'object') {
        try {
          // Skip tokens that are already known to be blacklisted
          if (this.blacklistedTokens.has(address)) {
            continue;
          }

          this.tokenMap[address] = {
            mint: address,
            symbol: token.symbol || "Unknown",
            name: token.name || "Unknown Token",
            decimals: token.decimals || 9,
            verified: this.knownGoodTokens.has(address)
          };
        } catch (e) {
          logger.debug(`Error processing token ${address}:`, e);
        }
      }
    }

    logger.info(`Initial scanner load with ${this.tokenMap.size} tokens`);

    // Start token verification if we need to
    if (this.knownGoodTokens.size < 10) {
      logger.info(`Only ${this.knownGoodTokens.size} verified tokens. Starting Jupiter token list download...`);
      this.tokenScanPromise = this.fetchJupiterTokens();
    } else {
      logger.info(`Using ${this.knownGoodTokens.size} previously verified tokens`);
      this.tokenScanPromise = Promise.resolve(true);
    }

    // Generate all possible routes from verified tokens
    this.generateAllRoutes();

    return true;
  }

  // Load cached tradable tokens
  private async loadTradableTokensCache(): Promise<void> {
    try {
      const cachePath = path.join(this.config.triangleScanner.reportDir, 'tradable-tokens.json');

      if (fs.existsSync(cachePath)) {
        const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));

        // Check if cache is still valid (less than 24 hours old)
        const now = Date.now();
        if (cacheData.timestamp && now - cacheData.timestamp < 24 * 60 * 60 * 1000) {
          // Add verified tokens
          if (cacheData.tradableTokens && Array.isArray(cacheData.tradableTokens)) {
            cacheData.tradableTokens.forEach((token: string) => this.knownGoodTokens.add(token));
          }

          // Add blacklisted tokens
          if (cacheData.blacklistedTokens && Array.isArray(cacheData.blacklistedTokens)) {
            cacheData.blacklistedTokens.forEach((token: string) => this.blacklistedTokens.add(token));
          }

          this.getLogger().info(`Loaded ${this.knownGoodTokens.size} tradable tokens and ${this.blacklistedTokens.size} blacklisted tokens from cache`);
          return;
        }
      }
    } catch (error) {
      this.getLogger().warn(`Error loading tradable tokens cache:`, error);
    }
  }

  // Save tradable tokens cache
  private saveTradableTokensCache(): void {
    try {
      const cachePath = path.join(this.config.triangleScanner.reportDir, 'tradable-tokens.json');

      const cacheData = {
        timestamp: Date.now(),
        tradableTokens: Array.from(this.knownGoodTokens),
        blacklistedTokens: Array.from(this.blacklistedTokens)
      };

      fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2));
      this.getLogger().info(`Saved ${this.knownGoodTokens.size} tradable tokens and ${this.blacklistedTokens.size} blacklisted tokens to cache`);
    } catch (error) {
      this.getLogger().warn(`Error saving tradable tokens cache:`, error);
    }
  }

  // Fetch Jupiter's token list to get verified tradable tokens
  private async fetchJupiterTokens(): Promise<boolean> {
    const logger = this.getLogger();
    try {
      logger.info(`Fetching Jupiter supported tokens...`);

      // Fetch Jupiter's token list directly
      const response = await fetch('https://token.jup.ag/all');

      if (!response.ok) {
        logger.warn(`Failed to fetch Jupiter tokens: ${response.status} ${response.statusText}`);
        return false;
      }

      const jupiterTokens: JupiterToken[] = await response.json();
      logger.info(`Downloaded ${jupiterTokens.length} tokens from Jupiter`);

      // Extract token addresses
      const jupiterTokenSet = new Set(jupiterTokens.map(token => token.address));

      // Update our token maps
      let verifiedCount = 0;
      let blacklistedCount = 0;

      // First add all Jupiter tokens to our known good list
      jupiterTokens.forEach(token => {
        this.knownGoodTokens.add(token.address);

        // If we already have this token in our map, mark it as verified
        if (this.tokenMap.has(token.address)) {
          const tokenData = this.tokenMap[token.address]!;
          tokenData.verified = true;
          this.tokenMap[token.address] = tokenData;
          verifiedCount++;
        } else {
          // Add it to our token map if it's not there
          this.tokenMap[token.address] = {
            mint: token.address,
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
            verified: true
          };
          verifiedCount++;
        }
      });

      // Remove any token we have that's not in Jupiter's list
      for (const address in this.tokenMap) {
        const token = this.tokenMap[address]
        if (!jupiterTokenSet.has(address) && !this.knownGoodTokens.has(address)) {
          // Mark as blacklisted
          this.blacklistedTokens.add(address);
          token.blacklisted = true;
          blacklistedCount++;
        }
      }

      logger.info(`Verified ${verifiedCount} tokens and blacklisted ${blacklistedCount} tokens`);

      // Save the updated tokens to cache
      this.saveTradableTokensCache();

      // Regenerate routes after updating token list
      this.generateAllRoutes();

      return true;
    } catch (error) {
      logger.error(`Error fetching Jupiter tokens:`, error);
      return false;
    }
  }

  // Generate all possible arbitrage routes
  private generateAllRoutes() {
    const logger = this.getLogger();

    // Clear existing queue
    this.routeQueue = [];

    // Generate triangular routes
    const routes = this.generateTriangularRoutes();

    this.totalRoutesGenerated = routes.length;

    // Add routes to queue with initial priority and last checked time
    for (const route of routes) {
      const routeKey = this.getRouteKey(route);
      const priority = this.getRoutePriority(routeKey, 'triangular');

      this.routeQueue.push({
        route,
        pattern: 'triangular',
        priority,
        lastChecked: 0
      });
    }

    // Sort queue by priority (highest first)
    this.sortRouteQueue();

    logger.info(`Generated ${this.totalRoutesGenerated} verified routes to scan`);
  }

  // Get unique key for a route
  private getRouteKey(route: string[]): string {
    return route.join('-');
  }

  // Get priority score for a route
  private getRoutePriority(routeKey: string, pattern: string): number {
    // Check if we have previous success score for this route
    let routeScore = this.routeScoreMap.get(routeKey) || 1.0;
    return routeScore;
  }

  // Sort route queue by priority
  private sortRouteQueue() {
    // Sort by priority (highest first), then by last checked time (oldest first)
    this.routeQueue.sort((a, b) => {
      // If priority significantly different, use that
      if (Math.abs(b.priority - a.priority) > 0.1) {
        return b.priority - a.priority;
      }
      // Otherwise use last checked time
      return a.lastChecked - b.lastChecked;
    });
  }

  // Generate triangular arbitrage routes (SOL -> token -> SOL)
  private generateTriangularRoutes(): string[][] {
    const routes: string[][] = [];
    const solMint = this.config.tokens.solMint;

    // For each token, create a triangular route: SOL -> token -> SOL
    for (const mint in this.tokenMap) {
      const token = this.tokenMap[mint]
      // Skip SOL itself
      if (mint === solMint) continue;

      // Skip blacklisted tokens
      if (this.blacklistedTokens.has(mint) || token.blacklisted) continue;

      // Only use tokens we've verified with Jupiter
      if (!token.verified && !this.knownGoodTokens.has(mint)) continue;

      // Create triangular route
      routes.push([solMint, mint, solMint]);
    }

    return routes;
  }

  // Start continuous scanning
  async startContinuousScanning(tradeSize?: number): Promise<boolean> {
    if (this.isScanning) {
      return false; // Already scanning
    }

    const logger = this.getLogger();

    // Set trade size
    this.tradeSize = tradeSize || this.config.arbitrage.maxTradeSize;

    logger.info(`Starting continuous scanning with trade size: ${this.tradeSize} SOL`);
    logger.info(`Request rate: 1 request every ${this.requestDelay}ms (${Math.floor(60000/this.requestDelay)} per minute)`);

    // Wait for token scan to complete if it's running
    if (this.tokenScanPromise) {
      logger.info(`Waiting for token verification to complete...`);
      await this.tokenScanPromise;
      this.tokenScanPromise = null;
    }

    this.isScanning = true;

    // Start processing routes from the queue
    this.processNextRoute();

    // Periodically log stats and re-sort the queue
    this.scanInterval = setInterval(() => {
      this.sortRouteQueue();

      // Log stats periodically
      this.scanCount++;

      const now = Date.now();
      if (this.lastOpportunityFound > 0) {
        const timeSinceLastOpp = now - this.lastOpportunityFound;
        const timeSinceLastOppMin = Math.round(timeSinceLastOpp / 60000);
        logger.info(`Last opportunity found: ${timeSinceLastOppMin} minutes ago`);
      }

      logger.info(`Stats: Scanned ${this.totalRoutesScanned}/${this.totalRoutesGenerated} routes, ${this.opportunities.length} opportunities found, ${this.errorCount} errors`);

      // Reset error count for the next period
      this.errorCount = 0;
    }, 60000); // Report every minute

    return true;
  }

  // Stop continuous scanning
  stopContinuousScanning(): boolean {
    if (!this.isScanning) {
      return false; // Not scanning
    }

    this.isScanning = false;

    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }

    this.getLogger().info(`Stopped continuous scanning after checking ${this.totalRoutesScanned} routes`);

    return true;
  }

  // Process next route from the queue
  private async processNextRoute() {
    if (!this.isScanning || this.routeQueue.length === 0) {
      // If we have no routes but have tokens, regenerate routes
      if (this.tokenMap.size > 0 && this.knownGoodTokens.size > 0) {
        this.generateAllRoutes();

        if (this.routeQueue.length > 0) {
          setTimeout(() => this.processNextRoute(), this.requestDelay);
          return;
        }
      }

      this.getLogger().warn(`No routes to process. Pausing scanning.`);
      return;
    }

    // Check if we're already at max concurrent requests
    if (this.currentlyActiveRequests >= this.maxConcurrentRequests) {
      // Schedule retry after a short delay
      setTimeout(() => this.processNextRoute(), 100);
      return;
    }

    // Get next route from queue
    const nextRoute = this.routeQueue.shift();

    if (!nextRoute) {
      // If queue is empty, regenerate routes
      this.generateAllRoutes();
      setTimeout(() => this.processNextRoute(), this.requestDelay);
      return;
    }

    // Update last checked time
    nextRoute.lastChecked = Date.now();

    // Process the route
    this.currentlyActiveRequests++;

    try {
      // Check if all tokens in route are verified
      const allTokensVerified = nextRoute.route.every(mint =>
        this.knownGoodTokens.has(mint) || (this.tokenMap[mint]?.verified ?? false)
      );

      if (!allTokensVerified) {
        throw new Error(`Route contains unverified tokens`);
      }

      // Check the route for arbitrage opportunity
      const opportunity = await this.checkRouteForArbitrage(nextRoute.route);

      // Reset consecutive errors on success
      this.consecutiveErrors = 0;
      this.backoffDelay = this.requestDelay;

      // If we found an opportunity, emit event and save it
      if (opportunity) {
        this.lastOpportunityFound = Date.now();
        this.opportunities.push(opportunity);

        // Sort opportunities by profit (highest first)
        this.opportunities.sort((a, b) => b.profitPercentage - a.profitPercentage);

        // Keep only the top 50 opportunities
        if (this.opportunities.length > 50) {
          this.opportunities = this.opportunities.slice(0, 50);
        }

        // Update route score (increase priority for successful routes)
        const routeKey = this.getRouteKey(nextRoute.route);
        const currentScore = this.routeScoreMap.get(routeKey) || 1.0;
        this.routeScoreMap.set(routeKey, currentScore * 1.5); // 50% boost to priority

        // Emit the opportunity event
        this.emit('opportunity', opportunity);

        // Save opportunity to file
        this.saveOpportunity(opportunity);

        // Log the opportunity
        const logger = this.getLogger();
        logger.info(`💰 PROFITABLE OPPORTUNITY:`);
        logger.info(`Route: ${opportunity.routeSymbols.join(' -> ')}`);
        logger.info(`Profit: ${opportunity.profit.toFixed(6)} SOL (${opportunity.profitPercentage.toFixed(2)}%)`);
      } else {
        // Slightly reduce priority for routes that didn't find opportunities
        const routeKey = this.getRouteKey(nextRoute.route);
        const currentScore = this.routeScoreMap.get(routeKey) || 1.0;
        this.routeScoreMap.set(routeKey, currentScore * 0.95); // 5% reduction
      }
    } catch (error: any) {
      // Increment error count
      this.errorCount++;
      this.consecutiveErrors++;

      // Check if the error is due to a non-tradable token
      if (error.message && typeof error.message === 'string') {
        const errorMsg = error.message.toLowerCase();

        // Handle "token not tradable" errors by blacklisting the token
        if (errorMsg.includes('token not tradable') || errorMsg.includes('token_not_tradable')) {
          // Try to extract token address from error message
          const matches = error.message.match(/token ([A-Za-z0-9]{32,44}) is not tradable/i);

          if (matches && matches[1]) {
            const tokenAddress = matches[1];
            this.blacklistedTokens.add(tokenAddress);

            // Update token in map if we have it
            if (this.tokenMap.has(tokenAddress)) {
              const token = this.tokenMap[tokenAddress]!;
              token.blacklisted = true;
              this.tokenMap[tokenAddress] = token;
            }

            this.getLogger().info(`Blacklisted non-tradable token: ${tokenAddress}`);

            // Save updated blacklist
            this.saveTradableTokensCache();
          } else {
            // If we can't extract the specific token, blacklist all non-SOL tokens in this route
            for (const mint of nextRoute.route) {
              if (mint !== this.config.tokens.solMint && !this.knownGoodTokens.has(mint)) {
                this.blacklistedTokens.add(mint);

                // Update token in map if we have it
                if (this.tokenMap.has(mint)) {
                  const token = this.tokenMap[mint]!;
                  token.blacklisted = true;
                  this.tokenMap[mint] = token;
                }

                this.getLogger().info(`Blacklisted potentially non-tradable token: ${mint}`);
              }
            }

            // Save updated blacklist
            this.saveTradableTokensCache();
          }
        }
      }

      // Log error
      if (this.consecutiveErrors <= 3 || this.consecutiveErrors % 10 === 0) {
        // Only log every 10th error after the first 3 to avoid flooding the console
        this.getLogger().warn(`Error checking route ${nextRoute.route.join(' -> ')}: ${error.message || error}`);
      }

      // Reduce priority for error routes more significantly
      const routeKey = this.getRouteKey(nextRoute.route);
      const currentScore = this.routeScoreMap.get(routeKey) || 1.0;
      this.routeScoreMap.set(routeKey, currentScore * 0.8); // 20% reduction

      // Implement exponential backoff if we're getting too many errors
      if (this.consecutiveErrors > 3) {
        this.backoffDelay = Math.min(this.backoffDelay * 1.5, this.maxBackoffDelay);

        if (this.consecutiveErrors % 10 === 0) {
          this.getLogger().warn(`Too many consecutive errors (${this.consecutiveErrors}). Backing off for ${this.backoffDelay}ms`);
        }
      }
    }

    // Add the route back to the queue with updated priority ONLY if it doesn't contain blacklisted tokens
    const containsBlacklisted = nextRoute.route.some(mint =>
      this.blacklistedTokens.has(mint) || (this.tokenMap[mint]?.blacklisted ?? false)
    );

    if (!containsBlacklisted) {
      const routeKey = this.getRouteKey(nextRoute.route);
      const newPriority = this.getRoutePriority(routeKey, nextRoute.pattern);

      this.routeQueue.push({
        ...nextRoute,
        priority: newPriority
      });
    } else {
      this.getLogger().debug(`Route ${nextRoute.route.join(' -> ')} contains blacklisted tokens, removing from queue`);
    }

    // Update counters
    this.totalRoutesScanned++;
    this.currentlyActiveRequests--;

    // Schedule next route check with delay (use backoff if needed)
    const currentDelay = this.consecutiveErrors > 3 ? this.backoffDelay : this.requestDelay;
    setTimeout(() => this.processNextRoute(), currentDelay);
  }

  // Find complex arbitrage paths with varied lengths
  async findComplexArbitrageOpportunities(tradeSize: number): Promise<Opportunity[]> {
    const logger = console; // Replace with your logger
    const opportunities: Opportunity[] = [];

    // Use only the configured source token
    const sourceToken = this.sourceToken;
    const sourceTokenInfo = this.tokenMap[sourceToken];
    const sourceSymbol = sourceTokenInfo?.symbol || 'UNKNOWN';

    logger.info(`Finding complex arbitrage paths starting from ${sourceSymbol}`);

    // Convert filtered tokens to array for easier use
    const filteredTokenArray = Array.from(this.filteredTokens);

    // Remove source token from intermediate options
    const intermediateTokens = filteredTokenArray.filter(token => token !== sourceToken);

    // Limit token count for performance
    const tokenLimit = this.config.tokenFilter.maxTokensToScan || 40;
    const candidateTokens = intermediateTokens.slice(0, tokenLimit);

    logger.info(`Selected ${candidateTokens.length} candidate tokens for route construction`);

    // Find 2-hop routes (source -> token1 -> source)
    logger.info('Finding 2-hop arbitrage routes...');
    for (const token1 of candidateTokens) {
      try {
        // Skip if token is excluded or not tradable
        if (this.excludedTokens.has(token1) && !this.includedTokens.has(token1)) {
          continue;
        }

        const paths = await this.findArbitragePath(
          sourceToken,
          tradeSize,
          [token1]
        );

        opportunities.push(...paths);
      } catch (error) {
        logger.debug(`Error finding 2-hop route with ${this.tokenMap[token1]?.symbol || token1}: ${error.message}`);
      }
    }

    // Find 3-hop routes (source -> token1 -> token2 -> source)
    logger.info('Finding 3-hop arbitrage routes...');

    // For 3-hop routes, use a smaller subset of tokens for performance
    const hop3Candidates = candidateTokens.slice(0, 20);

    for (const token1 of hop3Candidates) {
      for (const token2 of hop3Candidates) {
        // Skip if tokens are the same or excluded
        if (token1 === token2 ||
            (this.excludedTokens.has(token1) && !this.includedTokens.has(token1)) ||
            (this.excludedTokens.has(token2) && !this.includedTokens.has(token2))) {
          continue;
        }

        try {
          const paths = await this.findArbitragePath(
            sourceToken,
            tradeSize,
            [token1, token2]
          );

          opportunities.push(...paths);
        } catch (error) {
          // Don't log errors for 3-hop routes to reduce noise
          // logger.debug(`Error finding 3-hop route with ${this.tokenMap[token1]?.symbol} -> ${this.tokenMap[token2]?.symbol}: ${error.message}`);
        }
      }
    }

    // Find 4-hop routes for a very limited set of tokens
    // This is computationally expensive but can find rare opportunities
    if (this.config.arbitrage.findFourHopRoutes) {
      logger.info('Finding 4-hop arbitrage routes (limited set)...');

      // For 4-hop routes, use a very small subset of major tokens
      const majorTokenAddresses = [
        'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
        'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
        'F3nefJBcejYbtdREjui1T9DPh5dBgpkKq7u2GAAMXs5B', // WIF
      ];

      // Add top 5 tokens from includedTokens that aren't already in majorTokenAddresses
      const additionalTokens = Array.from(this.includedTokens)
        .filter(token => !majorTokenAddresses.includes(token))
        .slice(0, 5);

      const hop4Candidates = [...majorTokenAddresses, ...additionalTokens];

      // Try a limited set of 4-hop paths
      for (const token1 of hop4Candidates) {
        for (const token2 of hop4Candidates) {
          if (token1 === token2) continue;

          for (const token3 of hop4Candidates) {
            if (token1 === token3 || token2 === token3) continue;

            try {
              const paths = await this.findArbitragePath(
                sourceToken,
                tradeSize,
                [token1, token2, token3]
              );

              opportunities.push(...paths);
            } catch (error) {
              // Don't log 4-hop errors
            }
          }
        }
      }
    }

    // Sort opportunities by profit
    opportunities.sort((a, b) => b.profitPercentage - a.profitPercentage);

    // Log found opportunities
    logger.info(`Found ${opportunities.length} total arbitrage opportunities`);
    if (opportunities.length > 0) {
      logger.info(`Top opportunity: ${opportunities[0].routeSymbols.join(' -> ')} (${opportunities[0].profitPercentage.toFixed(2)}%)`);
    }

    return opportunities;
  }

  // Helper method to find a specific arbitrage path
  private async findArbitragePath(
    sourceToken: string,
    startAmount: number,
    intermediatePath: string[]
  ): Promise<Opportunity[]> {
    const opportunities: Opportunity[] = [];
    const logger = console; // Replace with your logger

    try {
      // Build the full token path (starts and ends with sourceToken)
      const fullPath = [sourceToken, ...intermediatePath, sourceToken];

      // Track the amount through each step
      let currentAmount = startAmount;
      const steps = [];
      const routeSymbols = [];

      // Add source token symbol
      routeSymbols.push(this.tokenMap[sourceToken]?.symbol || 'UNKNOWN');

      // Execute each step in the path
      for (let i = 0; i < fullPath.length - 1; i++) {
        const inputMint = fullPath[i];
        const outputMint = fullPath[i + 1];

        // Get quote for this step
        const quote = await this.jupiterApi.getQuote({
          inputMint: inputMint,
          outputMint: outputMint,
          amount: currentAmount,
          slippageBps: 50, // 0.5% slippage
        });

        if (!quote || !quote.routes || quote.routes.length === 0) {
          // No route available for this step
          return [];
        }

        // Use the best route
        const bestRoute = quote.routes[0];

        // Add symbol to route path
        routeSymbols.push(this.tokenMap[outputMint]?.symbol || 'UNKNOWN');

        // Update current amount to output of this step
        currentAmount = bestRoute.outAmount;

        // Store this step
        steps.push({
          inputMint,
          outputMint,
          inAmount: bestRoute.inAmount,
          outAmount: bestRoute.outAmount,
          route: bestRoute,
        });
      }

      // Calculate profit and profitability
      const profit = (steps[steps.length - 1].outAmount - startAmount) / Math.pow(10, this.tokenMap[sourceToken]?.decimals || 9);
      const profitPercentage = ((steps[steps.length - 1].outAmount - startAmount) / startAmount) * 100;

      // Only include if profitable
      if (profitPercentage > 0) {
        opportunities.push({
          startAmount,
          profit,
          profitPercentage,
          timestamp: Date.now(),
          steps,
          routeSymbols,
        });
      }
    } catch (error) {
      // Just rethrow so caller can handle
      throw error;
    }

    return opportunities;
  }

  // Check a specific route for arbitrage opportunities
  private async checkRouteForArbitrage(route: string[]): Promise<Opportunity | null> {
    try {
      const steps = [];
      let currentAmount = this.tradeSize;
      let currentMint = route[0];
      const tokenSymbols = [];
      const dexes = [];

      // Get token symbol for first mint
      const firstToken = this.tokenMap[currentMint];
      if (!firstToken) return null;

      // Calculate amount in token's smallest units
      currentAmount = currentAmount * (10 ** firstToken.decimals);
      tokenSymbols.push(firstToken.symbol);

      // Iterate through route steps
      for (let i = 1; i < route.length; i++) {
        const outputMint = route[i];
        const outputToken = this.tokenMap[outputMint];

        if (!outputToken) {
          return null;
        }

        tokenSymbols.push(outputToken.symbol);

        // Ensure the amount is a valid integer
        const inputAmount = Math.floor(currentAmount);
        if (isNaN(inputAmount) || inputAmount <= 0) {
          return null;
        }

        try {
          // Compute route for this step
          const stepResult = await this.jupiterApi.computeRoutes({
            inputMint: new PublicKey(currentMint),
            outputMint: new PublicKey(outputMint),
            amount: inputAmount,
            slippageBps: this.config.arbitrage.slippageTolerance * 100, // Convert to basis points
          });

          // If no routes found, abort
          if (!stepResult || !stepResult.routesInfos || stepResult.routesInfos.length === 0) {
            return null;
          }

          // Mark these tokens as verified if they work
          if (!this.knownGoodTokens.has(currentMint)) {
            this.knownGoodTokens.add(currentMint);
            if (this.tokenMap.has(currentMint)) {
              const token = this.tokenMap[currentMint]!;
              token.verified = true;
              this.tokenMap[currentMint] = token;
            }
          }

          if (!this.knownGoodTokens.has(outputMint)) {
            this.knownGoodTokens.add(outputMint);
            if (this.tokenMap.has(outputMint)) {
              const token = this.tokenMap[outputMint]!;
              token.verified = true;
              this.tokenMap[outputMint] = token;
            }
          }

          // Get best route for this step
          const bestRoute = stepResult.routesInfos[0];
          const outputAmount = Number(bestRoute.outAmount);

          // Track DEX used
          if (bestRoute.marketInfos && bestRoute.marketInfos.length > 0) {
            const dex = bestRoute.marketInfos[0]?.amm?.label || 'Unknown';
            dexes.push(dex);
          }

          // Update current state for next step
          currentAmount = outputAmount;
          currentMint = outputMint;

          // Store step information
          steps.push({
            inputMint: route[i-1],
            outputMint,
            inputAmount: i === 1 ? this.tradeSize : steps[i-2].outputAmount,
            outputAmount: outputAmount / (10 ** outputToken.decimals),
            route: bestRoute,
            dex: bestRoute.marketInfos?.[0]?.amm?.label || 'Unknown',
          });
        } catch (error: any) {
          // Add more detail to the error
          if (typeof error === 'object' && error !== null) {
            error.message = `Error in route step ${i} (${currentMint} -> ${outputMint}): ${error.message}`;
          }
          throw error;
        }
      }

      // Calculate profit
      const startTokenDecimals = this.tokenMap[route[0]]?.decimals || 9;

      // Calculate profit in tokens and percentage
      const startAmountInTokens = this.tradeSize;
      const endAmountInTokens = currentAmount / (10 ** startTokenDecimals);

      const profit = endAmountInTokens - startAmountInTokens;
      const profitPercentage = ((endAmountInTokens / startAmountInTokens) - 1) * 100;

      // Check profitability threshold
      const minThreshold = this.config.arbitrage.minimumProfitThreshold * 100;

      // Add gas cost estimate (approximately 0.00001 SOL per transaction)
      const estimatedGas = 0.00001 * (route.length - 1);

      // Adjust profit for gas costs
      const adjustedProfit = profit - estimatedGas;
      const adjustedProfitPercentage = ((endAmountInTokens - estimatedGas) / startAmountInTokens - 1) * 100;

      // Only return if still profitable after gas
      if (adjustedProfitPercentage >= minThreshold) {
        return {
          route: route,
          routeSymbols: tokenSymbols,
          startAmount: startAmountInTokens,
          endAmount: endAmountInTokens,
          profit: adjustedProfit,
          profitPercentage: adjustedProfitPercentage,
          timestamp: Date.now(),
          steps: steps,
          dexes: dexes
        };
      }

      return null;
    } catch (error) {
      // Add more context to the error
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);

      const contextualError = new Error(`Error computing route ${route.join(' -> ')}: ${errorMessage}`);
      throw contextualError;
    }
  }

  // Get the best opportunity
  getBestOpportunity(): Opportunity | null {
    if (this.opportunities.length === 0) {
      return null;
    }

    // Best opportunity is already at index 0 since we keep them sorted
    return this.opportunities[0];
  }

  // Get all opportunities
  getAllOpportunities(): Opportunity[] {
    return [...this.opportunities];
  }

  // Get scanned routes count
  getScannedRoutesCount(): number {
    return this.totalRoutesScanned;
  }

  // Get verified token count
  getVerifiedTokenCount(): number {
    return this.knownGoodTokens.size;
  }

  // Get blacklisted token count
  getBlacklistedTokenCount(): number {
    return this.blacklistedTokens.size;
  }

  // Save opportunity to file
  private saveOpportunity(opportunity: Opportunity) {
    try {
      const opportunitiesDir = path.join(this.config.triangleScanner.reportDir, 'opportunities');

      // Create directory if it doesn't exist
      if (!fs.existsSync(opportunitiesDir)) {
        fs.mkdirSync(opportunitiesDir, { recursive: true });
      }

      // Generate filename
      const timestamp = new Date(opportunity.timestamp)
        .toISOString().replace(/:/g, '-');
      const filename = `opportunity_${timestamp}_${opportunity.routeSymbols.join('_')}.json`;
      const filePath = path.join(opportunitiesDir, filename);

      // Save to file using Bun.write for Bun compatibility
      if (typeof Bun !== 'undefined') {
        Bun.write(filePath, JSON.stringify(opportunity, null, 2));
      } else {
        fs.writeFileSync(filePath, JSON.stringify(opportunity, null, 2));
      }
    } catch (error) {
      this.getLogger().error('Error saving opportunity:', error);
    }
  }
}
