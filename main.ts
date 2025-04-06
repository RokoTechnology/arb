// main.ts - Solana Arbitrage Bot with simplified paper trading
// Paper trading is always simulation mode, production is always real trades

import { startArbitrageBot } from './arbitrage-bot.ts';
import { startMempoolMonitor } from './mempool-monitor.ts';
import { Command } from 'commander';
import * as fs from 'fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { TokenListProvider } from '@solana/spl-token-registry';
import { PaperTrading } from './paper-trading.ts';
import { config } from './config'

// Define command-line interface
const program = new Command();

program
  .name('solana-arbitrage-bot')
  .description('A Solana arbitrage bot that detects and executes profitable trading opportunities')
  .version('1.0.0');

// Add commands
program
  .command('start')
  .description('Start the arbitrage bot')
  .option('-m, --mempool', 'Enable mempool monitoring for real-time opportunities', false)
  .option('-p, --paper-trading', 'Enable paper trading mode (simulation only)', false)
  .option('-d, --debug', 'Enable debug level logging', false)
  .action(async (options) => {
    try {
      // Load configuration
      console.log(`Loading configuration from ${config}`);

      // Override config with command line options
      if (options.debug) {
        config.logLevel = 'debug';
      }

      // Set paper trading mode based on command line option
      if (options.paperTrading !== undefined) {
        config.paperTradingMode = options.paperTrading;
      }

      // Set up Helius RPC connection
      const connection = new Connection(config.rpc.heliusRpcUrl, 'confirmed');

      // Validate connection
      console.log('Connecting to Solana via Helius RPC...');
      const version = await connection.getVersion();
      console.log(`Connected to Solana ${version['solana-core']}`);

      // Initialize paper trading if enabled
      if (config.paperTradingMode) {
        console.log('Initializing paper trading mode (simulation only)...');

        // Default paper trading config if not specified
        if (!config.paperTrading) {
          config.paperTrading = {
            initialBalance: {
              'So11111111111111111111111111111111111111112': 10, // 10 WSOL
              'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 100, // 100 USDC
            },
            slippageAdjustment: 0.005, // 0.5%
            gasFeesSimulation: true,
            recordDirectory: './paper-trading-records',
            successRate: 0.95,
            latencyMs: 300,
          };
        }

        // Load token information for paper trading
        console.log('Loading token information...');
        const tokenListProvider = new TokenListProvider();
        const tokenList = await tokenListProvider.resolve();
        const tokenListContainer = tokenList.getList();

        // Create token info map for paper trading
        const tokenInfo = {};
        tokenListContainer.forEach(token => {
          tokenInfo[token.address] = {
            mint: token.address,
            symbol: token.symbol,
            name: token.name,
            decimals: token.decimals,
          };
        });

        // Create logger for paper trading
        const logger = {
          debug: (...args) => config.logLevel === 'debug' && console.debug('[PAPER]', ...args),
          info: (...args) => console.info('[PAPER]', ...args),
          warn: (...args) => console.warn('[PAPER]', ...args),
          error: (...args) => console.error('[PAPER]', ...args),
        };

        // Initialize paper trading
        global.paperTrading = new PaperTrading(
          config.paperTrading,
          connection,
          tokenInfo,
          logger
        );

        console.log('Paper trading mode enabled. NO REAL TRANSACTIONS WILL BE EXECUTED.');
        console.log('Initial balances:');

        Object.entries(config.paperTrading.initialBalance).forEach(([mint, amount]) => {
          const symbol = tokenInfo[mint]?.symbol || mint.slice(0, 8) + '...';
          console.log(`- ${symbol}: ${amount}`);
        });
      } else {
        console.log('Production mode enabled. REAL TRANSACTIONS WILL BE EXECUTED.');
        console.log('Make sure you have sufficient funds in your wallet.');
      }

      // Start components based on options
      if (options.mempool) {
        console.log('Starting mempool monitor for real-time opportunities...');
        startMempoolMonitor();
      }

      console.log('Starting arbitrage bot...');
      console.log(`Mode: ${config.paperTradingMode ? 'Paper Trading (Simulation)' : 'Production (Real Trades)'}`);
      console.log(`Log level: ${config.logLevel}`);
      startArbitrageBot();

      // Setup periodic reports for paper trading
      if (config.paperTradingMode) {
        const reportInterval = config.paperTrading.reportInterval || 3600000; // Default: every hour
        setInterval(() => {
          const report = global.paperTrading.generateReport();
          console.log('\n' + report);

          // Save report to file
          const reportPath = global.paperTrading.saveReport();
          console.log(`Paper trading report saved to ${reportPath}`);
        }, reportInterval);
      }

    } catch (error) {
      console.error('Error starting bot:', error);
      process.exit(1);
    }
  });

// Add paper trading specific commands
program
  .command('paper-trading-report')
  .description('Generate a report from paper trading records')
  .option('-d, --directory <path>', 'Directory with paper trading records', './paper-trading-records')
  .action((options) => {
    try {
      console.log(`Generating report from records in ${options.directory}...`);

      if (!fs.existsSync(options.directory)) {
        console.error(`Directory ${options.directory} does not exist`);
        return;
      }

      const files = fs.readdirSync(options.directory);
      const tradeFiles = files.filter(f => f.startsWith('trade_'));
      const balanceFiles = files.filter(f => f.startsWith('balance_'));

      console.log(`Found ${tradeFiles.length} trade records and ${balanceFiles.length} balance records`);

      // Find the latest report if it exists
      const reportFiles = files.filter(f => f.startsWith('report_'));
      if (reportFiles.length > 0) {
        const latestReport = reportFiles
          .map(f => ({ name: f, time: parseInt(f.replace('report_', '').replace('.txt', '')) }))
          .sort((a, b) => b.time - a.time)[0];

        console.log(`Latest report: ${latestReport.name}`);
        const reportContent = fs.readFileSync(`${options.directory}/${latestReport.name}`, 'utf-8');
        console.log('\n' + reportContent);
      } else {
        console.log('No existing reports found.');
      }

    } catch (error) {
      console.error('Error generating paper trading report:', error);
    }
  });

program
  .command('paper-trading-reset')
  .description('Reset paper trading balances and history')
  .option('-b, --balances <json>', 'Initial balances as JSON string')
  .action((options) => {
    try {
      console.log('Resetting paper trading data...');

      // Set default paper trading configuration if not present
      if (!config.paperTrading) {
        config.paperTrading = {
          initialBalance: {
            'So11111111111111111111111111111111111111112': 10, // 10 WSOL
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 100, // 100 USDC
          },
          recordDirectory: './paper-trading-records',
        };
      }

      // Override initial balances if provided
      if (options.balances) {
        try {
          config.paperTrading.initialBalance = JSON.parse(options.balances);
          console.log('Using provided initial balances');
        } catch (e) {
          console.error('Error parsing provided balances, using defaults');
        }
      }

      // Get record directory
      const recordDir = config.paperTrading.recordDirectory;

      // Clean existing records
      if (fs.existsSync(recordDir)) {
        console.log(`Cleaning existing records in ${recordDir}...`);

        const files = fs.readdirSync(recordDir);
        let deletedCount = 0;

        files.forEach(file => {
          if (file.match(/^(trade|balance|report)_/)) {
            fs.unlinkSync(`${recordDir}/${file}`);
            deletedCount++;
          }
        });

        console.log(`Deleted ${deletedCount} records`);
      } else {
        // Create directory if it doesn't exist
        console.log(`Creating record directory ${recordDir}...`);
        fs.mkdirSync(recordDir, { recursive: true });
      }

      // Create a fresh latest_balance.json with initial values
      const initialBalance = {
        timestamp: Date.now(),
        balances: config.paperTrading.initialBalance,
        totalValueUSD: 0 // This would be calculated properly in a real implementation
      };

      fs.writeFileSync(
        `${recordDir}/latest_balance.json`,
        JSON.stringify(initialBalance, null, 2)
      );

      console.log('Paper trading data reset successfully');
      console.log('Initial balances:');
      Object.entries(config.paperTrading.initialBalance).forEach(([key, value]) => {
        console.log(`- ${key}: ${value}`);
      });

    } catch (error) {
      console.error('Error resetting paper trading data:', error);
    }
  });

program
  .command('paper-trading-analyze')
  .description('Analyze paper trading performance and generate insights')
  .option('-d, --directory <path>', 'Directory with paper trading records', './paper-trading-records')
  .option('-p, --period <days>', 'Analysis period in days', '30')
  .action((options) => {
    try {
      console.log(`Analyzing paper trading performance for the last ${options.period} days...`);

      if (!fs.existsSync(options.directory)) {
        console.error(`Directory ${options.directory} does not exist`);
        return;
      }

      // Find all trade records
      const files = fs.readdirSync(options.directory);
      const tradeFiles = files.filter(f => f.startsWith('trade_'));
      const balanceFiles = files.filter(f => f.startsWith('balance_'));

      if (tradeFiles.length === 0) {
        console.log('No trade records found for analysis');
        return;
      }

      console.log(`Found ${tradeFiles.length} trade records and ${balanceFiles.length} balance records`);

      // Load and parse trade records
      // In a real implementation, this would perform detailed analysis
      console.log('Analysis would summarize:');
      console.log('- Profit by day of week and hour of day');
      console.log('- Most profitable tokens and routes');
      console.log('- Success rates and profit percentages');
      console.log('- Performance comparison with market averages');

    } catch (error) {
      console.error('Error analyzing paper trading data:', error);
    }
  });

program
  .command('analyze-dexes')
  .description('Analyze DEXes to find which ones offer the best arbitrage opportunities')
  .option('-d, --days <days>', 'Number of days of historical data to analyze', '7')
  .action(async (options) => {
    try {
      // Load configuration
      console.log(`Loading configuration from ${config}`);

      // Set up connection
      const connection = new Connection(config.rpc.heliusRpcUrl, 'confirmed');

      console.log(`Analyzing DEX data for the past ${options.days} days...`);

      // This would use Helius' historical data APIs to analyze past transactions
      console.log('This feature would analyze historical DEX activity using Helius APIs');
      console.log('It would identify patterns like:');
      console.log('- Which DEXes frequently have price discrepancies');
      console.log('- What time of day arbitrage opportunities are most common');
      console.log('- Which token pairs offer the most arbitrage potential');

    } catch (error) {
      console.error('Error in DEX analysis:', error);
      process.exit(1);
    }
  });

program
  .command('setup-wallet')
  .description('Set up a new wallet for arbitrage trading')
  .option('-o, --output <path>', 'Output path for wallet key file', './wallet-key.json')
  .action(() => {
    try {
      console.log('This feature would help set up a dedicated wallet for arbitrage');
      console.log('For security reasons, please set up your wallet manually using Solana CLI tools');
      console.log('Once set up, save the private key (securely!) and update your config file');

    } catch (error) {
      console.error('Error in wallet setup:', error);
      process.exit(1);
    }
  });

// Run the program
if (import.meta.main) {
  program.parse();
} else {
  console.log('Example configuration:');
}
