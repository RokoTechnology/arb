// main.ts - Solana Arbitrage Bot with separate paper and production commands
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

// Common setup function for both modes
const setupAndStart = async () => {
  try {
    console.log('Starting Solana Arbitrage Bot...');
    console.log('Loading configuration...');

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

    // Start mempool monitor if enabled in config
    if (config.mempool && config.mempool.enabled) {
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
};

// Command for paper trading mode
program
  .command('paper')
  .description('Start the arbitrage bot in paper trading mode (simulation only)')
  .action(() => {
    // Force paper trading mode
    config.paperTrading.enabled = true;
    setupAndStart();
  });

// Command for production mode
program
  .command('prod')
  .description('Start the arbitrage bot in production mode (executes real transactions)')
  .action(() => {
    // Force production mode
    config.paperTrading.enabled = false;

    // Add an extra confirmation for production mode
    console.log('\n⚠️  WARNING: You are about to start the bot in PRODUCTION mode ⚠️');
    console.log('Real transactions will be executed with real tokens.');

    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });

    readline.question('Are you sure you want to proceed? (yes/no): ', (answer) => {
      readline.close();
      if (answer.toLowerCase() === 'yes') {
        setupAndStart();
      } else {
        console.log('Production mode startup cancelled. Exiting...');
        process.exit(0);
      }
    });
  });

// Run the program
if (import.meta.main) {
  program.parse();
}
