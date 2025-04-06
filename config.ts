// config.ts - Configuration for Solana Arbitrage Bot with Triangular Scanner

import { Connection } from '@solana/web3.js';

// Configuration interface
export interface ArbConfig {
  // Connection settings
  rpc: {
    heliusRpcUrl: string;
    heliusWsUrl: string;
    commitment: 'processed' | 'confirmed' | 'finalized';
    timeout: number;
  };

  // Wallet settings
  wallet: {
    privateKeyPath: string;
    gasBuffer: number; // SOL to reserve for gas fees
  };

  // Arbitrage settings
  arbitrage: {
    minimumProfitThreshold: number; // Minimum profit percentage to execute trade (e.g. 0.008 = 0.8%)
    maxTradeSize: number; // Maximum SOL value to trade
    slippageTolerance: number; // Slippage tolerance in percentage (e.g. 0.5 = 0.5%)
    routeTimeout: number; // Milliseconds to consider a found route still valid
    monitoringInterval: number; // Milliseconds between opportunity scans
    maxConcurrentScans: number; // Maximum number of concurrent scans
  };

  // Token settings
  tokens: {
    basePairs: string[]; // Base token pairs to use for arbitrage (e.g. WSOL, USDC)
    maxTokensToScan: number; // Maximum number of tokens to include in scanning
    tokenBlacklist: string[]; // Token addresses to exclude
    solMint: string; // SOL mint address
  };

  // DEX settings
  dexes: {
    [dex: string]: boolean; // Which DEXes to include
  };

  // Paper trading settings
  paperTrading: {
    enabled: boolean;
    initialBalance: {
      [tokenMint: string]: number;
    };
    slippageAdjustment: number;
    gasFeesSimulation: boolean;
    recordDirectory: string;
    successRate: number;
    latencyMs: number;
    reportInterval: number;
  };

  // Monitoring & alerting
  monitoring: {
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    saveLogsToFile: boolean;
    logDirectory: string;
    alertOnProfit: boolean;
    profitAlertThreshold: number;
    alertWebhook?: string;
  };

  // Performance settings
  performance: {
    useCache: boolean;
    cacheTimeout: number;
    maxRouteDepth: number; // Maximum number of hops in a route
  };

  // Mempool monitoring settings
  mempool: {
    enabled: boolean;
    transactionTypes: string[];
    filterByToken: boolean;
    targetTokens: string[];
    minTransactionValue: number;
  };

  // Triangular scanner settings
  triangleScanner: {
    enabled: boolean;
    reportDir: string;
    tokenCacheTime: number;
    requestInterval: number;
    birdeyeApiKey?: string;
    maxRoutesPerScan: number;
  };
}

const HELIUS_KEY = process.env.HELIUS_KEY || '43cc204e-ea49-4017-8623-123f776557de'

// Direct configuration
export const config: ArbConfig = {
  rpc: {
    heliusRpcUrl: 'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY,
    heliusWsUrl: 'wss://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY,
    commitment: 'confirmed',
    timeout: 30000,
  },

  wallet: {
    privateKeyPath: process.env.PRIVATE_KEY_PATH || './wallet-key.json',
    gasBuffer: 0.01, // 0.01 SOL
  },

  arbitrage: {
    minimumProfitThreshold: parseFloat(process.env.MIN_PROFIT_THRESHOLD || '0.003'), // 0.3%
    maxTradeSize: parseFloat(process.env.MAX_TRADE_SIZE || '10'), // 10 SOL
    slippageTolerance: 0.5, // 0.5%
    routeTimeout: 3000, // 3 seconds
    monitoringInterval: parseInt(process.env.MONITORING_INTERVAL || '20000'), // 20 seconds
    maxConcurrentScans: 2,
  },

  tokens: {
    basePairs: [
      'So11111111111111111111111111111111111111112', // WSOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    ],
    maxTokensToScan: 50,
    tokenBlacklist: [
      // Add any tokens you want to exclude here
    ],
    solMint: 'So11111111111111111111111111111111111111112',
  },

  dexes: {
    jupiterAggregator: true,
    raydium: true,
    orca: true,
    aldrin: false,
    crema: true,
    meteora: true,
    openbook: false,
  },

  paperTrading: {
    enabled: process.env.PAPER_TRADING === 'true' || true,
    initialBalance: {
      'So11111111111111111111111111111111111111112': 10, // 10 WSOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 100, // 100 USDC
    },
    slippageAdjustment: 0.005, // 0.5%
    gasFeesSimulation: true,
    recordDirectory: './paper-trading-records',
    successRate: 0.95, // 95% success rate
    latencyMs: 300, // 300ms simulated latency
    reportInterval: 3600000, // Generate reports hourly
  },

  monitoring: {
    logLevel: (process.env.LOG_LEVEL as any) || 'debug',
    saveLogsToFile: true,
    logDirectory: './logs',
    alertOnProfit: true,
    profitAlertThreshold: 0.1, // Alert for profits > 0.1 SOL
    alertWebhook: undefined,
  },

  performance: {
    useCache: true,
    cacheTimeout: 60000, // 1 minute
    maxRouteDepth: 4, // Max 4 hops in a route
  },

  // Mempool settings
  mempool: {
    enabled: process.env.MEMPOOL_ENABLED === 'true' || true,
    transactionTypes: ['swap', 'liquidity'],
    filterByToken: true,
    targetTokens: [
      'So11111111111111111111111111111111111111112', // WSOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    ],
    minTransactionValue: 1000, // Minimum transaction value to monitor (in USD)
  },

  // Triangular scanner settings
  triangleScanner: {
    enabled: true, // Enable triangular scanner by default
    reportDir: './arbitrage-reports',
    tokenCacheTime: 86400000, // 24 hours in milliseconds
    requestInterval: 200, // 200ms between requests to avoid rate limits
    maxRoutesPerScan: 100, // Maximum routes to scan per iteration
    birdeyeApiKey: process.env.BIRDEYE_API_KEY || '', // Optional Birdeye API key for token data
  },
};

// Create connection from config
export function createConnection(): Connection {
  return new Connection(config.rpc.heliusRpcUrl, {
    commitment: config.rpc.commitment,
    confirmTransactionInitialTimeout: config.rpc.timeout,
  });
}
