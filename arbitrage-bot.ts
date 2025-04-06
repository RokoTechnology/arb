// arbitrage-bot.ts - Solana Arbitrage Bot with Paper Trading
// Cleaned version without flash loan code and unnecessary imports

import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import { Jupiter } from '@jup-ag/core';
import * as fs from 'fs';
import { config } from './config';
import { PaperTrading } from './paper-trading';

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

// Setup Jupiter for best swap routes
async function setupJupiter(connection: Connection, wallet: PublicKey) {
  try {
    const jupiter = await Jupiter.load({
      connection,
      cluster: 'mainnet-beta',
      user: wallet,
    });
    return jupiter;
  } catch (error) {
    console.error('Error setting up Jupiter:', error);
    throw new Error('Failed to initialize Jupiter. Check your connection.');
  }
}

// Function to generate potential arbitrage routes
function generateArbitrageRoutes(tokenMap: any) {
  // Get major tokens for triangle arbitrage
  const majorTokens = config.tokens.basePairs;

  // Get a selection of other tokens with good liquidity
  // In a real implementation, you would filter based on volume or liquidity
  const secondaryTokens = Object.keys(tokenMap).slice(0, config.tokens.maxTokensToScan);

  // Generate triangle arbitrage routes
  const routes: string[][] = [];

  // Always start with WSOL for simplicity
  const startToken = 'So11111111111111111111111111111111111111112'; // WSOL

  // Generate 2-hop routes (triangular arbitrage)
  for (const token1 of majorTokens) {
    if (token1 === startToken) continue;

    for (const token2 of secondaryTokens) {
      if (token2 === startToken || token2 === token1) continue;
      if (config.tokens.tokenBlacklist.includes(token2)) continue;

      routes.push([startToken, token1, token2, startToken]);
    }
  }

  return routes;
}

// Function to find arbitrage opportunities
async function findArbitrageOpportunities(
  jupiter: any,
  routes: string[][],
  tokenMap: any,
  startingAmount: number,
  logger: any
) {
  let bestOpportunity = null;
  let highestProfitPercentage = 0;

  for (const route of routes) {
    try {
      let currentAmount = startingAmount;
      const swapSteps = [];
      let invalidRoute = false;

      // Simulate each swap in the route
      for (let i = 0; i < route.length - 1; i++) {
        const inputMint = route[i];
        const outputMint = route[i + 1];

        // Get token decimals
        const inputDecimals = tokenMap[inputMint]?.decimals || 9;

        // Calculate amount in smallest units
        const inputAmount = currentAmount * (10 ** inputDecimals);

        // Compute route using Jupiter
        const routeInfo = await jupiter.computeRoutes({
          inputMint: new PublicKey(inputMint),
          outputMint: new PublicKey(outputMint),
          amount: inputAmount,
          slippageBps: config.arbitrage.slippageTolerance * 100, // Convert percentage to basis points
        });

        if (!routeInfo.routesInfos || routeInfo.routesInfos.length === 0) {
          invalidRoute = true;
          break;
        }

        const bestSwap = routeInfo.routesInfos[0];
        const outputDecimals = tokenMap[outputMint]?.decimals || 9;
        const outputAmount = bestSwap.outAmount / (10 ** outputDecimals);

        currentAmount = outputAmount;
        swapSteps.push({
          inputMint,
          outputMint,
          inputAmount: currentAmount,
          outputAmount,
          route: bestSwap,
          dex: bestSwap.marketInfos?.[0]?.amm?.label || 'Unknown',
        });
      }

      if (invalidRoute) continue;

      // Calculate profit
      const profit = currentAmount - startingAmount;
      const profitPercentage = (profit / startingAmount) * 100;

      logger.debug(`Route ${route.map(t => tokenMap[t]?.symbol || t).join(' -> ')} - Profit: ${profit.toFixed(6)} SOL (${profitPercentage.toFixed(2)}%)`);

      // Update best opportunity if this is more profitable
      if (profitPercentage > highestProfitPercentage && profitPercentage > 0) {
        highestProfitPercentage = profitPercentage;
        bestOpportunity = {
          route,
          steps: swapSteps,
          startAmount: startingAmount,
          endAmount: currentAmount,
          profit,
          profitPercentage,
          timeStamp: Date.now(),
        };
      }
    } catch (error: any) {
      logger.debug(`Error simulating route ${route.join(' -> ')}:`, error.message);
      continue;
    }
  }

  return bestOpportunity;
}

// Execute the arbitrage trade (or simulate with paper trading)
async function executeArbitrage(
  jupiter: any,
  opportunity: any,
  tokenMap: any,
  logger: any,
  paperTradingInstance?: any
) {
  try {
    logger.info('Executing arbitrage trade...');
    logger.info(`Route: ${opportunity.route.map((t: string) => tokenMap[t]?.symbol || t).join(' -> ')}`);
    logger.info(`Expected profit: ${opportunity.profit.toFixed(6)} SOL (${opportunity.profitPercentage.toFixed(2)}%)`);

    // Check if opportunity is still fresh
    const timeSinceDiscovery = Date.now() - opportunity.timeStamp;
    if (timeSinceDiscovery > config.arbitrage.routeTimeout) {
      logger.warn(`Opportunity expired (${timeSinceDiscovery}ms old). Recalculating...`);
      return { success: false, reason: 'expired' };
    }

    // Paper trading mode - delegate to paper trading handler
    if (config.paperTrading.enabled && paperTradingInstance) {
      logger.info('Paper trading mode active - simulating trade execution');
      return await paperTradingInstance.executeTrade(opportunity, jupiter);
    }

    // Real trading execution
    logger.info('Executing real arbitrage trade...');

    // Execute each swap in sequence
    let currentAmount = opportunity.startAmount;

    for (const step of opportunity.steps) {
      logger.info(`Executing swap: ${tokenMap[step.inputMint]?.symbol || step.inputMint} -> ${tokenMap[step.outputMint]?.symbol || step.outputMint}`);

      const result = await jupiter.exchange({
        routeInfo: step.route,
      });

      if (!result.txid) {
        throw new Error('Failed to execute swap. No transaction ID returned.');
      }

      logger.info(`Swap complete. Transaction: ${result.txid}`);
    }

    // Verify final balance and calculate actual profit
    // In a real implementation, you would check the final token balance here

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

// Main arbitrage monitoring function
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

    // Setup Jupiter instance
    const jupiter = await setupJupiter(connection, walletPublicKey);
    logger.info('Jupiter initialized successfully');

    // Generate potential arbitrage routes
    const routes = generateArbitrageRoutes(tokenMap);
    logger.info(`Generated ${routes.length} potential arbitrage routes`);

    // Get available balance
    const wsol = 'So11111111111111111111111111111111111111112';
    const availableBalance = config.paperTrading.enabled && paperTradingInstance
      ? (paperTradingInstance.getBalance(wsol) || 10) // Use paper trading balance
      : await getTokenBalance(connection, wsol, walletPublicKey);

    logger.info(`Available WSOL balance: ${availableBalance}`);

    // Determine trade size (either available balance or max trade size, whichever is smaller)
    // Also reserve some SOL for gas fees
    const tradeSize = Math.min(availableBalance - config.wallet.gasBuffer, config.arbitrage.maxTradeSize);

    if (tradeSize <= 0) {
      logger.error(`Insufficient balance to execute trades. Need at least ${config.wallet.gasBuffer} SOL for gas fees.`);
      return null;
    }

    logger.info(`Scanning for arbitrage opportunities with trade size: ${tradeSize} WSOL`);

    // Find best opportunity
    const opportunity = await findArbitrageOpportunities(jupiter, routes, tokenMap, tradeSize, logger);

    if (!opportunity) {
      logger.info('No profitable arbitrage opportunities found in this scan');
      return null;
    }

    logger.info(`Found profitable opportunity!`);
    logger.info(`Route: ${opportunity.route.map((t: string) => tokenMap[t]?.symbol || t).join(' -> ')}`);
    logger.info(`Expected profit: ${opportunity.profit.toFixed(6)} SOL (${opportunity.profitPercentage.toFixed(2)}%)`);

    // Check if opportunity meets minimum profit threshold
    if (opportunity.profitPercentage < config.arbitrage.minimumProfitThreshold * 100) {
      logger.info(`Opportunity profitability (${opportunity.profitPercentage.toFixed(2)}%) below threshold (${config.arbitrage.minimumProfitThreshold * 100}%). Skipping execution.`);
      return null;
    }

    // Execute the arbitrage (real or paper)
    return await executeArbitrage(jupiter, opportunity, tokenMap, logger, paperTradingInstance);

  } catch (error) {
    logger.error('Error monitoring arbitrage opportunities:', error);
    return null;
  }
}

// Function for simulating arbitrage (used by CLI simulation command)
export async function simulateArbitrage(
  connection: Connection,
  startTokenMint: PublicKey,
  amount: number
) {
  console.log(`Simulating arbitrage starting with ${amount} of token ${startTokenMint.toString()}`);

  // This is a simpler version of monitorArbitrageOpportunities focused on simulation
  try {
    // Setup Jupiter instance
    const jupiter = await Jupiter.load({
      connection,
      cluster: 'mainnet-beta',
      user: new PublicKey('11111111111111111111111111111111'), // Dummy wallet for simulation
    });

    console.log('Jupiter initialized for simulation');

    // Load token information
    const tokenMap = await loadTokenList();

    // Generate a set of potential routes to try
    const routes = [
      // Triangle arbitrage routes (A -> B -> A)
      [startTokenMint.toString(), 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', startTokenMint.toString()],

      // In a real implementation, this would generate more routes
      // based on token pairs with good liquidity
    ];

    console.log(`Generated ${routes.length} routes to simulate`);

    // Track profitable routes
    const profitableRoutes = [];

    // Simulate each route
    for (const route of routes) {
      try {
        let currentAmount = amount;
        const steps = [];
        let invalidRoute = false;

        console.log(`Simulating route: ${route.map(mint => tokenMap[mint]?.symbol || mint).join(' -> ')}`);

        // Simulate each hop in the route
        for (let i = 0; i < route.length - 1; i++) {
          const inputMint = route[i];
          const outputMint = route[i + 1];

          // Get token decimals
          const inputDecimals = tokenMap[inputMint]?.decimals || 9;

          // Calculate amount in smallest units
          const inputAmount = currentAmount * (10 ** inputDecimals);

          // Compute route using Jupiter
          console.log(`  Computing route: ${tokenMap[inputMint]?.symbol || inputMint} -> ${tokenMap[outputMint]?.symbol || outputMint}`);
          const routeInfo = await jupiter.computeRoutes({
            inputMint: new PublicKey(inputMint),
            outputMint: new PublicKey(outputMint),
            amount: inputAmount,
            slippageBps: 50, // 0.5%
          });

          if (!routeInfo.routesInfos || routeInfo.routesInfos.length === 0) {
            console.log(`  No routes found for ${tokenMap[inputMint]?.symbol || inputMint} -> ${tokenMap[outputMint]?.symbol || outputMint}`);
            invalidRoute = true;
            break;
          }

          // Find best route
          const bestSwap = routeInfo.routesInfos[0];
          const outputDecimals = tokenMap[outputMint]?.decimals || 9;
          const outputAmount = bestSwap.outAmount / (10 ** outputDecimals);

          // Get DEX info
          const dex = bestSwap.marketInfos?.[0]?.amm?.label || 'Unknown';

          console.log(`  Swap on ${dex}: ${currentAmount.toFixed(6)} ${tokenMap[inputMint]?.symbol || inputMint} -> ${outputAmount.toFixed(6)} ${tokenMap[outputMint]?.symbol || outputMint}`);

          currentAmount = outputAmount;
          steps.push({
            inputMint,
            outputMint,
            inputAmount,
            outputAmount,
            dex
          });
        }

        if (invalidRoute) {
          console.log('  Route invalid - skipping');
          continue;
        }

        // Calculate profit
        const profit = currentAmount - amount;
        const profitPercentage = (profit / amount) * 100;

        console.log(`  Result: ${amount.toFixed(6)} -> ${currentAmount.toFixed(6)}`);
        console.log(`  Profit: ${profit.toFixed(6)} (${profitPercentage.toFixed(2)}%)`);

        // Record if profitable
        if (profit > 0) {
          profitableRoutes.push({
            route,
            routeDescription: route.map(mint => tokenMap[mint]?.symbol || mint).join(' -> '),
            startAmount: amount,
            endAmount: currentAmount,
            profit,
            profitPercentage,
            dexes: steps.map(step => step.dex),
            steps
          });
        }

      } catch (error: any) {
        console.error(`Error simulating route:`, error.message);
      }
    }

    // Return simulation results
    return {
      simulatedRoutes: routes.length,
      profitableRoutes,
      startToken: startTokenMint.toString(),
      startAmount: amount,
    };

  } catch (error) {
    console.error('Error in arbitrage simulation:', error);
    return {
      error: (error as Error).message,
      simulatedRoutes: 0,
      profitableRoutes: []
    };
  }
}

// Main function to start the arbitrage bot
export function startArbitrageBot() {
  const logger = createLogger();
  logger.info('Starting Solana arbitrage bot with Helius RPC...');

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
        startMonitoring(connection, paperTradingInstance);
      });
    });
  } else {
    // Start monitoring without paper trading
    startMonitoring(connection);
  }
}

// Function to start the monitoring loop
function startMonitoring(connection: Connection, paperTradingInstance?: any) {
  const logger = createLogger();

  // Main monitoring loop
  let runCount = 0;
  let successfulTrades = 0;
  let totalProfit = 0;

  // Set up the monitoring interval
  const intervalId = setInterval(async () => {
    runCount++;
    logger.info(`Scan #${runCount} - Starting arbitrage opportunity search`);

    try {
      const result = await monitorArbitrageOpportunities(connection, paperTradingInstance);

      // Process result
      if (result && result.success) {
        successfulTrades++;
        totalProfit += result.profit;

        logger.info(`Arbitrage statistics:`);
        logger.info(`- Total successful trades: ${successfulTrades}`);
        logger.info(`- Total profit: ${totalProfit.toFixed(6)} SOL`);
        logger.info(`- Success rate: ${(successfulTrades / runCount * 100).toFixed(2)}%`);
      }
    } catch (error) {
      logger.error('Error in monitoring cycle:', error);
    }
  }, config.arbitrage.monitoringInterval);

  // Ensure we can stop the bot gracefully
  process.on('SIGINT', () => {
    clearInterval(intervalId);
    logger.info('Arbitrage bot stopped. Summary:');
    logger.info(`- Total scans: ${runCount}`);
    logger.info(`- Successful trades: ${successfulTrades}`);
    logger.info(`- Total profit: ${totalProfit.toFixed(6)} SOL`);
    logger.info(`- Success rate: ${(successfulTrades / runCount * 100).toFixed(2)}%`);

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
  simulateArbitrage,
  startArbitrageBot,
};
