// main.ts - Solana Arbitrage Bot with simplified control options
// Simplified to just handle production vs paper trading modes

import { startArbitrageBot } from './arbitrage-bot';
import { startMempoolMonitor } from './mempool-monitor';
import { Command } from 'commander';
import { Connection } from '@solana/web3.js';
import { config } from './config';

// Define command-line interface
const program = new Command();

program
  .name('solana-arbitrage-bot')
  .description('A Solana arbitrage bot that detects and executes profitable trading opportunities')
  .version('1.0.0');

// Add main start command with simplified options
program
  .command('start')
  .description('Start the arbitrage bot')
  .option('-p, --paper-trading', 'Enable paper trading mode (simulation only)', false)
  .option('-m, --mempool', 'Enable mempool monitoring for real-time opportunities', false)
  .option('-d, --debug', 'Enable debug level logging', false)
  .action(async (options) => {
    try {
      console.log('Starting Solana Arbitrage Bot...');
      console.log('Loading configuration...');

      // Override config with command line options
      if (options.debug) {
        config.monitoring.logLevel = 'debug';
      }

      // Set paper trading mode based on command line option
      if (options.paperTrading !== undefined) {
        config.paperTrading.enabled = options.paperTrading;
      }

      // Set mempool monitoring based on command line option
      if (options.mempool !== undefined) {
        config.mempool.enabled = options.mempool;
      }

      // Set up Helius RPC connection
      const connection = new Connection(config.rpc.heliusRpcUrl, 'confirmed');

      // Validate connection
      console.log('Connecting to Solana via Helius RPC...');
      try {
        const version = await connection.getVersion();
        console.log(`Connected to Solana ${version['solana-core']}`);
      } catch (error) {
        console.error('Error connecting to Solana network:', error);
        process.exit(1);
      }

      // Display mode information
      if (config.paperTrading.enabled) {
        console.log('PAPER TRADING MODE ACTIVE - NO REAL TRANSACTIONS WILL BE EXECUTED');
      } else {
        console.log('PRODUCTION MODE ACTIVE - REAL TRANSACTIONS WILL BE EXECUTED');
        console.log('Make sure you have sufficient funds in your wallet.');
      }

      console.log(`Log level: ${config.monitoring.logLevel}`);

      // Start mempool monitor if enabled
      if (config.mempool.enabled) {
        console.log('Starting mempool monitor for real-time opportunities...');
        await startMempoolMonitor();
      }

      // Start the main arbitrage bot
      console.log('Starting arbitrage bot...');
      startArbitrageBot();

    } catch (error) {
      console.error('Error starting bot:', error);
      process.exit(1);
    }
  });

// Run the program
if (import.meta.main) {
  program.parse();
}
