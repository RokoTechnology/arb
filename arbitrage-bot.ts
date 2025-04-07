// arbitrage-bot.ts - Enhanced version with token filtering
import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import { config } from './config';
import { PaperTrading } from './paper-trading';
import { JupiterAPI, setupJupiterAPI } from './jupiter-api';
import { ContinuousScanner, Opportunity } from './continuous-scanner';

// Initialize logger
const createLogger = () => {
  return {
    debug: (...args: any[]) => config.monitoring.logLevel === 'debug' && console.debug(new Date().toISOString(), ...args),
    info: (...args: any[]) => ['debug', 'info'].includes(config.monitoring.logLevel) && console.info(new Date().toISOString(), ...args),
    warn: (...args: any[]) => ['debug', 'info', 'warn'].includes(config.monitoring.logLevel) && console.warn(new Date().toISOString(), ...args),
    error: (...args: any[]) => console.error(new Date().toISOString(), ...args),
  };
};

// Load token list information
async function loadTokenList() {
  try {
    const { TokenListProvider } = await import('@solana/spl-token-registry');
    const tokenListProvider = new TokenListProvider();
    const tokenList = await tokenListProvider.resolve();
    const tokenListContainer = tokenList.getList();

    // Create a map of token address to token info
    const tokenMap = tokenListContainer.reduce((acc: any, token: any) => {
      acc[token.address] = token;
      return acc;
    }, {});

    return tokenMap;
  } catch (error) {
    console.error('Error loading token list:', error);
    // Return a minimal token map with major tokens if we can't load the full list
    return {
      'So11111111111111111111111111111111111111112': { symbol: 'SOL', name: 'Solana', decimals: 9 },
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC', name: 'USD Coin', decimals: 6 },
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB': { symbol: 'USDT', name: 'USDT', decimals: 6 },
    };
  }
}

// Execute the arbitrage trade (or simulate with paper trading)
async function executeArbitrage(
  jupiterApi: JupiterAPI,
  opportunity: Opportunity,
  tokenMap: any,
  logger: any,
  paperTradingInstance?: any
) {
  try {
    logger.info('Executing arbitrage trade...');
    logger.info(`Route: ${opportunity.routeSymbols.join(' -> ')}`);
    logger.info(`Expected profit: ${opportunity.profit.toFixed(6)} SOL (${opportunity.profitPercentage.toFixed(2)}%)`);

    // Check if opportunity is still fresh
    const timeSinceDiscovery = Date.now() - opportunity.timestamp;
    if (timeSinceDiscovery > config.arbitrage.routeTimeout) {
      logger.warn(`Opportunity expired (${timeSinceDiscovery}ms old). Recalculating...`);
      return { success: false, reason: 'expired' };
    }

    // Paper trading mode - delegate to paper trading handler
    if (config.paperTrading.enabled && paperTradingInstance) {
      logger.info('Paper trading mode active - simulating trade execution');
      return await paperTradingInstance.executeTrade(opportunity, jupiterApi);
    }

    // Real trading execution
    logger.info('Executing real arbitrage trade...');

    // Execute each swap in sequence
    let currentAmount = opportunity.startAmount;

    for (const step of opportunity.steps) {
      const inputSymbol = tokenMap[step.inputMint]?.symbol || step.inputMint;
      const outputSymbol = tokenMap[step.outputMint]?.symbol || step.outputMint;

      logger.info(`Executing swap: ${inputSymbol} -> ${outputSymbol}`);

      const result = await jupiterApi.exchange({
        routeInfo: step.route,
      });

      if (!result.txid) {
        throw new Error('Failed to execute swap. No transaction ID returned.');
      }

      logger.info(`Swap complete. Transaction: ${result.txid}`);
    }

    logger.info(`Arbitrage complete!`);

    return {
      success: true,
      profit: opportunity.profit,
      profitPercentage: opportunity.profitPercentage,
    };
  } catch (error: any) {
    logger.error('Error executing arbitrage:', error);
    return {
      success: false,
      reason: 'execution_error',
      error: error.message,
    };
  }
}

// Load wallet
function loadWallet(privateKeyPath: string): Keypair {
  try {
    const keyData = JSON.parse(fs.readFileSync(privateKeyPath, 'utf-8'));
    return Keypair.fromSecretKey(new Uint8Array(keyData));
  } catch (error) {
    console.error('Error loading wallet:', error);
    throw new Error('Failed to load wallet. Make sure your key file exists and is valid.');
  }
}

// Main arbitrage monitoring function using continuous scanning
// Update your monitorArbitrageOpportunities function in arbitrage-bot.ts

export async function monitorArbitrageOpportunities(connection: Connection, paperTradingInstance?: any) {
  const logger = createLogger();

  try {
    // Load token information
    const tokenMap = await loadTokenList();
    logger.info(`Loaded information for ${Object.keys(tokenMap).length} tokens`);

    // Load wallet or use dummy wallet for paper trading
    const walletPublicKey = config.paperTrading.enabled
      ? new PublicKey('11111111111111111111111111111111') // Dummy wallet for paper trading
      : loadWallet(config.wallet.privateKeyPath).publicKey; // Real wallet for actual trades

    // Setup Jupiter API wrapper
    const jupiterApi = setupJupiterAPI();
    logger.info('Jupiter API initialized successfully');

    // Initialize continuous scanner with token filtering
    const scanner = new ContinuousScanner(connection, jupiterApi, config);
    await scanner.initialize(tokenMap);
    logger.info('Continuous scanner initialized with token filtering');

    // Get available balance
    const sourceToken = config.arbitrage.sourceToken || 'So11111111111111111111111111111111111111112';
    const availableBalance = config.paperTrading.enabled && paperTradingInstance
      ? (paperTradingInstance.getBalance(sourceToken) || 10) // Use paper trading balance
      : await getTokenBalance(connection, sourceToken, walletPublicKey);

    const sourceSymbol = tokenMap[sourceToken]?.symbol || 'UNKNOWN';
    logger.info(`Available ${sourceSymbol} balance: ${availableBalance}`);

    // Determine trade size (either available balance or max trade size, whichever is smaller)
    // Also reserve some for gas fees
    const tradeSize = Math.min(availableBalance - config.wallet.gasBuffer, config.arbitrage.maxTradeSize);

    if (tradeSize <= 0) {
      logger.error(`Insufficient balance to execute trades. Need at least ${config.wallet.gasBuffer} ${sourceSymbol} for gas fees.`);
      return null;
    }

    // Set up opportunity handler
    scanner.on('opportunity', async (opportunity: Opportunity) => {
      logger.info(`Processing new opportunity: ${opportunity.routeSymbols.join(' -> ')}`);

      // Check if opportunity meets minimum profit threshold
      if (opportunity.profitPercentage < config.arbitrage.minimumProfitThreshold * 100) {
        logger.info(`Opportunity profitability (${opportunity.profitPercentage.toFixed(2)}%) below threshold (${config.arbitrage.minimumProfitThreshold * 100}%). Skipping execution.`);
        return;
      }

      // Calculate estimated profit in USD
      const profitInSourceToken = opportunity.profit;
      let estimatedUsdProfit = 0;

      // If source token is SOL, estimate USD value (rough approximation)
      if (sourceToken === 'So11111111111111111111111111111111111111112') {
        // Approximate SOL price - in production you'd want to fetch this from an oracle
        const approximateSolPriceUsd = 150; // Replace with real price data
        estimatedUsdProfit = profitInSourceToken * approximateSolPriceUsd;
        logger.info(`Estimated profit: $${estimatedUsdProfit.toFixed(2)} USD`);
      }

      // Execute the arbitrage (real or paper)
      const result = await executeArbitrage(jupiterApi, opportunity, tokenMap, logger, paperTradingInstance);

      if (result.success) {
        logger.info(`Successfully executed arbitrage!`);
        logger.info(`Profit: ${result.profit.toFixed(6)} ${sourceSymbol} (${result.profitPercentage.toFixed(2)}%)`);

        // Record successful trade stats
        if (paperTradingInstance) {
          paperTradingInstance.recordTrade({
            timestamp: Date.now(),
            route: opportunity.routeSymbols.join(' -> '),
            profit: result.profit,
            profitPercentage: result.profitPercentage
          });
        }
      } else {
        logger.warn(`Failed to execute arbitrage: ${result.reason}`);
      }
    });

    // Start continuous scanning with the determined trade size
    logger.info(`Starting continuous scanning for arbitrage opportunities with trade size: ${tradeSize} ${sourceSymbol}`);
    await scanner.startContinuousScanning(tradeSize);

    return scanner; // Return scanner instance so it can be stopped later if needed
  } catch (error) {
    logger.error('Error setting up arbitrage monitoring:', error);
    return null;
  }
}

// Add these helper functions to your arbitrage-bot.ts file

// Function to detect and handle pump tokens specifically
function isPumpToken(tokenAddress: string, tokenInfo: any): boolean {
  // Check if address ends with 'pump' (case insensitive)
  if (tokenAddress.toLowerCase().endsWith('pump')) {
    return true;
  }

  // Check name and symbol
  const name = (tokenInfo?.name || '').toLowerCase();
  const symbol = (tokenInfo?.symbol || '').toLowerCase();

  // Common patterns in pump token names/symbols
  return (
    name.includes('pump') ||
    symbol.includes('pump') ||
    name.includes('moon') ||
    symbol.includes('moon') ||
    name.includes('pepe') ||
    symbol.includes('pepe')
  );
}

// Function to log token statistics from the filtering process
function logTokenFilteringStats(filteredTokens: Set<string>, tokenMap: any, includedTokens: Set<string>) {
  // Count tokens by category
  const categoryCounts: Record<string, number> = {
    'verified': 0,
    'pump': 0,
    'meme': 0,
    'stablecoin': 0,
    'defi': 0,
    'other': 0,
    'manually_included': includedTokens.size
  };

  // Categorize each token
  filteredTokens.forEach(tokenAddress => {
    const token = tokenMap[tokenAddress];
    if (!token) return;

    // Check token tags and name for categorization
    if (isPumpToken(tokenAddress, token)) {
      categoryCounts['pump']++;
    } else if (token.tags?.includes('stablecoin') ||
              ['usdc', 'usdt', 'dai', 'busd'].includes(token.symbol?.toLowerCase())) {
      categoryCounts['stablecoin']++;
    } else if (token.tags?.includes('meme') ||
              token.name?.toLowerCase().includes('dog') ||
              token.name?.toLowerCase().includes('cat') ||
              ['doge', 'shib', 'samo', 'bonk'].includes(token.symbol?.toLowerCase())) {
      categoryCounts['meme']++;
    } else if (token.tags?.includes('defi') ||
              token.name?.toLowerCase().includes('swap') ||
              token.name?.toLowerCase().includes('lend') ||
              token.name?.toLowerCase().includes('yield')) {
      categoryCounts['defi']++;
    } else {
      categoryCounts['other']++;
    }

    if (token.verified || token.tags?.includes('verified')) {
      categoryCounts['verified']++;
    }
  });

  // Log the statistics
  console.info('=== Token Filtering Statistics ===');
  console.info(`Total filtered tokens: ${filteredTokens.size}`);
  console.info(`Verified tokens: ${categoryCounts['verified']}`);
  console.info(`Stablecoins: ${categoryCounts['stablecoin']}`);
  console.info(`Meme tokens: ${categoryCounts['meme']}`);
  console.info(`Pump tokens: ${categoryCounts['pump']}`);
  console.info(`DeFi tokens: ${categoryCounts['defi']}`);
  console.info(`Other tokens: ${categoryCounts['other']}`);
  console.info(`Manually included tokens: ${categoryCounts['manually_included']}`);
  console.info('================================');
}

// Enhanced function to check if a token should be excluded based on risk factors
function shouldExcludeToken(tokenAddress: string, tokenInfo: any, config: any): { exclude: boolean, reason?: string } {
  // Always exclude known scam tokens
  if (config.tokenFilter.excludedTokens.includes(tokenAddress)) {
    return { exclude: true, reason: "explicitly_excluded" };
  }

  // Check for suspicious name patterns
  const name = (tokenInfo?.name || '').toLowerCase();
  const symbol = (tokenInfo?.symbol || '').toLowerCase();

  const suspiciousPatterns = [
    'scam', 'rug', 'liq', 'fake', 'exploit', 'hack',
    'elon', 'musk', 'bezos', 'steal', 'ponzi'
  ];

  // Check for highly suspicious patterns (these are almost always scams)
  for (const pattern of suspiciousPatterns) {
    if (name.includes(pattern) || symbol.includes(pattern)) {
      // Unless explicitly included
      if (!config.tokenFilter.includedTokens.includes(tokenAddress)) {
        return { exclude: true, reason: `suspicious_pattern_${pattern}` };
      }
    }
  }

  // Risky but not automatically excluded patterns for pump tokens
  if (tokenAddress.toLowerCase().endsWith('pump')) {
    // Apply stricter criteria for pump tokens

    // Check if it's explicitly included
    if (config.tokenFilter.includedTokens.includes(tokenAddress)) {
      return { exclude: false };
    }

    // For pump tokens not in the includedTokens list, apply stricter checks
    // (This would be implementation-specific based on your risk tolerance)
    return { exclude: true, reason: "unvetted_pump_token" };
  }

  // Default to not excluding
  return { exclude: false };
}

// Function to generate trading insights based on detected opportunities
function generateArbitrageInsights(opportunities: Opportunity[], tokenMap: any): string {
  if (!opportunities || opportunities.length === 0) {
    return "No arbitrage opportunities detected in this scanning cycle.";
  }

  // Sort by profitability
  const sortedOpps = [...opportunities].sort((a, b) => b.profitPercentage - a.profitPercentage);

  // Take top 5 or fewer
  const topOpps = sortedOpps.slice(0, 5);

  let insights = "=== Top Arbitrage Opportunities ===\n";

  topOpps.forEach((opp, index) => {
    // Format the route with token symbols
    const route = opp.routeSymbols.join(' → ');

    insights += `${index + 1}. ${route}: ${opp.profitPercentage.toFixed(2)}% profit\n`;

    // Add volume info if available
    if (opp.estimatedVolume) {
      insights += `   Est. 24h volume: $${Math.round(opp.estimatedVolume).toLocaleString()}\n`;
    }
  });

  // Add pattern analysis
  insights += "\nInsights:\n";

  // Check for patterns in profitable routes
  const hasStablecoinRoutes = topOpps.some(opp =>
    opp.routeSymbols.some(symbol => ['USDC', 'USDT', 'DAI', 'BUSD'].includes(symbol))
  );

  const hasPumpTokenRoutes = topOpps.some(opp =>
    opp.routeSymbols.some(symbol => symbol.toLowerCase().includes('pump'))
  );

  const hasMemeTokenRoutes = topOpps.some(opp =>
    opp.routeSymbols.some(symbol =>
      ['DOGE', 'SHIB', 'BONK', 'WIF', 'POPCAT', 'BODEN'].includes(symbol))
  );

  const avgHops = topOpps.reduce((sum, opp) => sum + opp.routeSymbols.length - 1, 0) / topOpps.length;

  // Add relevant insights
  if (hasStablecoinRoutes) {
    insights += "• Stablecoin paths present in profitable routes\n";
  }

  if (hasPumpTokenRoutes) {
    insights += "• Pump tokens present in profitable routes - higher risk\n";
  }

  if (hasMemeTokenRoutes) {
    insights += "• Meme tokens present in profitable routes\n";
  }

  insights += `• Average path length: ${avgHops.toFixed(1)} hops\n`;

  // Add best DEX if we have that information
  // This would require tracking which DEXes are used in each step

  return insights;
}

// Get token balance
async function getTokenBalance(connection: Connection, tokenMint: string, owner: PublicKey): Promise<number> {
  try {
    // If querying SOL balance
    if (tokenMint === 'So11111111111111111111111111111111111111112') {
      const balance = await connection.getBalance(owner);
      return balance / 10 ** 9; // Convert from lamports to SOL
    }

    // For other tokens
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      owner,
      { mint: new PublicKey(tokenMint) }
    );

    if (tokenAccounts.value.length === 0) {
      return 0;
    }

    const account = tokenAccounts.value[0];
    return account.account.data.parsed.info.tokenAmount.uiAmount;
  } catch (error) {
    console.error(`Error getting balance for token ${tokenMint}:`, error);
    return 0;
  }
}

// Main function to start the arbitrage bot with continuous scanning
export function startArbitrageBot() {
  const logger = createLogger();
  logger.info('Starting Solana arbitrage bot with token filtering and continuous scanning...');

  // Paper trading notification
  if (config.paperTrading.enabled) {
    logger.info('PAPER TRADING MODE ACTIVE - NO REAL TRANSACTIONS WILL BE EXECUTED');
  }

  // Set up connection
  const connection = new Connection(config.rpc.heliusRpcUrl, 'confirmed');

  // Initialize paper trading if enabled
  let paperTradingInstance;
  if (config.paperTrading.enabled) {
    // Load token information for paper trading
    import('@solana/spl-token-registry').then(({ TokenListProvider }) => {
      const tokenListProvider = new TokenListProvider();
      tokenListProvider.resolve().then(tokenList => {
        const tokenListContainer = tokenList.getList();

        // Create token info map for paper trading
        const tokenInfo: any = {};
        tokenListContainer.forEach((token: any) => {
          tokenInfo[token.address] = {
            mint: token.address,
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
          };
        });

        paperTradingInstance = new PaperTrading(
          config.paperTrading,
          connection,
          tokenInfo,
          logger
        );

        // Start monitoring after paper trading is initialized
        monitorArbitrageOpportunities(connection, paperTradingInstance);
      });
    });
  } else {
    // Start monitoring without paper trading
    monitorArbitrageOpportunities(connection);
  }

  // Setup graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Arbitrage bot stopped');

    // Generate paper trading report if enabled
    if (config.paperTrading.enabled && paperTradingInstance) {
      const reportPath = paperTradingInstance.saveReport();
      logger.info(`Paper trading final report saved to ${reportPath}`);
    }

    process.exit(0);
  });
}

// Export the functions
export default {
  monitorArbitrageOpportunities,
  executeArbitrage,
  startArbitrageBot,
};
