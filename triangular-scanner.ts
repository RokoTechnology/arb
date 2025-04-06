// triangular-scanner.ts - Scanner for triangular arbitrage opportunities
import { Connection, PublicKey } from '@solana/web3.js';
import { JupiterAPI, setupJupiterAPI } from './jupiter-api';
import { BirdeyeFetcher, TokenData } from './birdeye-fetcher';
import * as fs from 'fs';
import * as path from 'path';
import { config, ArbConfig } from './config';

// Opportunity interface
interface Opportunity {
  route: string[];
  routeSymbols: string[];
  startAmount: number;
  endAmount: number;
  profit: number;
  profitPercentage: number;
  timestamp: number;
  steps: any[];
}

export class TriangularScanner {
  private connection: Connection;
  private jupiterApi: JupiterAPI;
  private tokenFetcher: BirdeyeFetcher;
  private config: ArbConfig;
  private tokenMap: Map<string, TokenData> = new Map();
  private solToken: TokenData;
  private opportunities: Opportunity[] = [];
  private lastScanTime = 0;
  private scanCount = 0;

  constructor(connection: Connection, config: ArbConfig = config) {
    this.connection = connection;
    this.config = config;

    // Initialize Jupiter API with rate limiting
    const requestsPerSecond = 1000 / config.triangleScanner.requestInterval;
    this.jupiterApi = setupJupiterAPI(requestsPerSecond);

    // Initialize token fetcher
    this.tokenFetcher = new BirdeyeFetcher(
      config.birdeyeApiKey,
      path.join(config.triangleScanner.reportDir, 'cache'),
      config.triangleScanner.tokenCacheTime
    );

    // Define SOL token
    this.solToken = {
      symbol: 'SOL',
      name: 'Solana',
      mint: config.tokens.solMint,
      decimals: 9
    };
  }

  // Initialize scanner - load top tokens
  async initialize() {
    const logPrefix = this.config.paperTrading.enabled ? 'PAPER' : 'PRODUCTION';
    console.log(`[${logPrefix}] Initializing triangular arbitrage scanner...`);

    // Create report directory if it doesn't exist
    if (!fs.existsSync(this.config.triangleScanner.reportDir)) {
      fs.mkdirSync(this.config.triangleScanner.reportDir, { recursive: true });
    }

    // Fetch top tokens by volume
    await this.refreshTokenList();

    console.log(`[${logPrefix}] Scanner initialized with ${this.tokenMap.size} tokens`);
    console.log(`[${logPrefix}] Starting continuous scan for triangular arbitrage opportunities...`);
  }

  // Refresh token list from Birdeye API
  async refreshTokenList() {
    try {
      const tokens = await this.tokenFetcher.fetchTopTokensByVolume(this.config.tokens.maxTokensToScan);

      // Clear existing token map
      this.tokenMap.clear();

      // Add tokens to map
      for (const token of tokens) {
        this.tokenMap.set(token.mint, token);
      }

      // Check if SOL is in the list, add if not
      if (!this.tokenMap.has(this.config.tokens.solMint)) {
        this.tokenMap.set(this.config.tokens.solMint, this.solToken);
      }

      console.log(`Updated token list with ${this.tokenMap.size} tokens`);
    } catch (error) {
      console.error('Error refreshing token list:', error);
    }
  }

  // Generate triangular arbitrage routes (SOL -> token -> SOL)
  private generateTriangularRoutes(): string[][] {
    const routes: string[][] = [];
    const solMint = this.config.tokens.solMint;

    // For each token, create a triangular route: SOL -> token -> SOL
    for (const [mint, token] of this.tokenMap.entries()) {
      // Skip SOL itself
      if (mint === solMint) continue;

      // Skip blacklisted tokens
      if (this.config.tokens.tokenBlacklist.includes(mint)) continue;

      // Create triangular route
      routes.push([solMint, mint, solMint]);
    }

    return routes;
  }

  // Create logger for consistent log format matching main bot
  private getLogger() {
    const logPrefix = this.config.paperTrading.enabled ? 'PAPER' : 'PRODUCTION';
    return {
      debug: (...args: any[]) => {
        if (this.config.monitoring.logLevel === 'debug') {
          console.debug(`[${logPrefix}] [${new Date().toISOString()}]`, ...args);
        }
      },
      info: (...args: any[]) => {
        if (['debug', 'info'].includes(this.config.monitoring.logLevel)) {
          console.info(`[${logPrefix}] [${new Date().toISOString()}]`, ...args);
        }
      },
      warn: (...args: any[]) => {
        if (['debug', 'info', 'warn'].includes(this.config.monitoring.logLevel)) {
          console.warn(`[${logPrefix}] [${new Date().toISOString()}]`, ...args);
        }
      },
      error: (...args: any[]) => {
        console.error(`[${logPrefix}] [${new Date().toISOString()}]`, ...args);
      }
    };
  }

  // Scan for arbitrage opportunities with a specific amount
  async scanForOpportunities(tradeSize?: number): Promise<boolean> {
    const logger = this.getLogger();
    this.scanCount++;
    logger.info(`Scan #${this.scanCount} - Looking for triangular arbitrage opportunities`);

    // Clear previous opportunities
    this.opportunities = [];

    // Use provided trade size or default from config
    const tradeSizeToUse = tradeSize || this.config.arbitrage.maxTradeSize;

    // Generate routes to scan
    const routes = this.generateTriangularRoutes();
    logger.debug(`Generated ${routes.length} triangular routes to scan`);

    // Calculate trade size in lamports (SOL's smallest unit)
    const tradeSizeInLamports = tradeSizeToUse * 10 ** this.solToken.decimals;

    let scannedRoutes = 0;
    let profitableRoutes = 0;

    // Scan each route for arbitrage opportunities
    for (const route of routes) {
      try {
        // Get token information
        const inputMint = route[0];
        const middleMint = route[1];
        const outputMint = route[2];

        const inputToken = this.tokenMap.get(inputMint);
        const middleToken = this.tokenMap.get(middleMint);

        if (!inputToken || !middleToken) {
          logger.debug(`Missing token info for route ${route.join(' -> ')}`);
          continue;
        }

        // Log progress occasionally
        if (scannedRoutes % 10 === 0 && scannedRoutes > 0) {
          logger.debug(`Scanned ${scannedRoutes}/${routes.length} routes...`);
        }

        scannedRoutes++;

        // Step 1: SOL -> token
        const step1Result = await this.jupiterApi.computeRoutes({
          inputMint: new PublicKey(inputMint),
          outputMint: new PublicKey(middleMint),
          amount: tradeSizeInLamports,
          slippageBps: this.config.arbitrage.slippageTolerance * 100, // Convert decimal to basis points
        });

        if (!step1Result.routesInfos || step1Result.routesInfos.length === 0) {
          // No route found for first step
          continue;
        }

        const bestStep1 = step1Result.routesInfos[0];
        const middleAmount = bestStep1.outAmount; // In middle token's smallest units

        // Step 2: token -> SOL
        const step2Result = await this.jupiterApi.computeRoutes({
          inputMint: new PublicKey(middleMint),
          outputMint: new PublicKey(outputMint),
          amount: Number(middleAmount),
          slippageBps: this.config.arbitrage.slippageTolerance * 100,
        });

        if (!step2Result.routesInfos || step2Result.routesInfos.length === 0) {
          // No route found for second step
          continue;
        }

        const bestStep2 = step2Result.routesInfos[0];
        const finalAmount = bestStep2.outAmount; // In SOL's smallest units

        // Calculate profit
        const startAmountNumber = Number(tradeSizeInLamports);
        const endAmountNumber = Number(finalAmount);

        const profit = (endAmountNumber - startAmountNumber) / (10 ** this.solToken.decimals);
        const profitPercentage = ((endAmountNumber / startAmountNumber) - 1) * 100; // Convert to percentage

        // Check if profitable above threshold
        if (profitPercentage > this.config.arbitrage.minimumProfitThreshold * 100) {
          profitableRoutes++;

          const opportunity: Opportunity = {
            route: [inputMint, middleMint, outputMint],
            routeSymbols: [
              inputToken.symbol,
              middleToken.symbol,
              inputToken.symbol
            ],
            startAmount: tradeSizeToUse,
            endAmount: endAmountNumber / (10 ** this.solToken.decimals),
            profit: profit,
            profitPercentage: profitPercentage,
            timestamp: Date.now(),
            steps: [
              {
                inputMint,
                outputMint: middleMint,
                inputAmount: tradeSizeToUse,
                outputAmount: Number(middleAmount) / (10 ** middleToken.decimals),
                route: bestStep1,
                dex: bestStep1.marketInfos?.[0]?.amm?.label || 'Unknown',
              },
              {
                inputMint: middleMint,
                outputMint,
                inputAmount: Number(middleAmount) / (10 ** middleToken.decimals),
                outputAmount: endAmountNumber / (10 ** this.solToken.decimals),
                route: bestStep2,
                dex: bestStep2.marketInfos?.[0]?.amm?.label || 'Unknown',
              }
            ]
          };

          this.opportunities.push(opportunity);

          logger.info(`💰 PROFITABLE OPPORTUNITY FOUND:`);
          logger.info(`Route: ${opportunity.routeSymbols.join(' -> ')}`);
          logger.info(`Profit: ${profit.toFixed(6)} SOL (${profitPercentage.toFixed(2)}%)`);
          logger.info(`DEXes: ${opportunity.steps.map(s => s.dex).join(' -> ')}`);

          // Save opportunity to file
          this.saveOpportunity(opportunity);
        }
      } catch (error) {
        logger.debug(`Error scanning route ${route.join(' -> ')}:`, error);
      }
    }

    logger.info(`Scan complete: Scanned ${scannedRoutes}/${routes.length} routes, found ${profitableRoutes} profitable opportunities`);

    // Return true if profitable opportunities were found
    return profitableRoutes > 0;
  }

  // Get the best opportunity (most profitable)
  async getBestOpportunity(): Promise<Opportunity | null> {
    if (this.opportunities.length === 0) {
      return null;
    }

    // Sort opportunities by profit percentage (descending)
    this.opportunities.sort((a, b) => b.profitPercentage - a.profitPercentage);

    // Return the most profitable opportunity
    return this.opportunities[0];
  }

  // Get all opportunities
  async getAllOpportunities(): Promise<Opportunity[]> {
    return [...this.opportunities];
  }

  // Get the number of routes scanned in the last run
  getScannedRoutesCount(): number {
    return this.scanCount;
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
      const timestamp = new Date(opportunity.timestamp).toISOString().replace(/:/g, '-');
      const filename = `opportunity_${timestamp}_${opportunity.routeSymbols.join('_')}.json`;
      const filePath = path.join(opportunitiesDir, filename);

      // Save to file
      fs.writeFileSync(filePath, JSON.stringify(opportunity, null, 2));

      const logger = this.getLogger();
      logger.debug(`Opportunity saved to ${filePath}`);
    } catch (error) {
      console.error('Error saving opportunity:', error);
    }
  }

  // Send profit alert if webhook is configured
  private sendProfitAlert(opportunity: Opportunity) {
    const webhook = this.config.monitoring.alertWebhook;
    if (!webhook) return;

    try {
      // Format alert message
      const message = {
        content: `⚠️ Triangular Arbitrage Opportunity Alert ⚠️`,
        embeds: [{
          title: `Found profitable arbitrage: ${opportunity.routeSymbols.join(' -> ')}`,
          description: `Profit: ${opportunity.profit.toFixed(6)} SOL (${opportunity.profitPercentage.toFixed(2)}%)`,
          color: 0x00ff00,
          fields: [
            {
              name: 'Route',
              value: opportunity.routeSymbols.join(' -> '),
              inline: true
            },
            {
              name: 'DEXes',
              value: opportunity.steps.map(s => s.dex).join(' -> '),
              inline: true
            },
            {
              name: 'Trade Size',
              value: `${opportunity.startAmount} SOL`,
              inline: true
            },
            {
              name: 'End Amount',
              value: `${opportunity.endAmount.toFixed(6)} SOL`,
              inline: true
            },
            {
              name: 'Timestamp',
              value: new Date(opportunity.timestamp).toISOString(),
              inline: true
            }
          ],
          timestamp: new Date().toISOString()
        }]
      };

      // Send webhook
      fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message)
      }).catch(err => console.error('Error sending webhook alert:', err));

    } catch (error) {
      console.error('Error sending profit alert:', error);
    }
  }

  // Start continuous scanning
  async startContinuousScan() {
    // Initialize first
    await this.initialize();

    // Run continuously
    const scanLoop = async () => {
      try {
        await this.scanForOpportunities();
        // Schedule next scan based on monitoring interval
        setTimeout(scanLoop, 1000); // Just a small delay to prevent blocking the event loop
      } catch (error) {
        const logger = this.getLogger();
        logger.error('Error during scan:', error);
        // Continue scanning even after errors
        setTimeout(scanLoop, 5000); // Longer delay after error
      }
    };

    // Start the scan loop
    scanLoop();
  }
}
