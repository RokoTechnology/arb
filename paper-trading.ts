// paper-trading.ts - Paper Trading implementation for Solana Arbitrage Bot
import { Connection, PublicKey } from '@solana/web3.js';
import { Jupiter, RouteInfo } from '@jup-ag/core';
import * as fs from 'fs';
import path from 'path';

// Paper trading configuration type
interface PaperTradingConfig {
  enabled: boolean;
  initialBalance: {
    [tokenMint: string]: number;
  };
  slippageAdjustment: number; // Factor to adjust expected profits to simulate real-world slippage
  gasFeesSimulation: boolean; // Whether to deduct simulated gas fees from profits
  recordDirectory: string; // Directory to store trade records
  successRate: number; // Simulated success rate (0-1) to account for failed transactions
  latencyMs: number; // Simulated latency in milliseconds
}

// Trade record type
interface TradeRecord {
  timestamp: number;
  route: string[];
  tokenSymbols: string[];
  startToken: string;
  startAmount: number;
  expectedEndAmount: number;
  adjustedEndAmount: number; // After simulated slippage
  profit: number;
  profitPercentage: number;
  gasUsed?: number;
  successful: boolean;
  failureReason?: string;
  dexes: string[];
}

// Balance record type
interface BalanceRecord {
  timestamp: number;
  balances: {
    [tokenMint: string]: number;
  };
  totalValueUSD: number;
}

// Token info for readable logs
interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
}

export class PaperTrading {
  private config: PaperTradingConfig;
  private balances: { [tokenMint: string]: number } = {};
  private tradeHistory: TradeRecord[] = [];
  private balanceHistory: BalanceRecord[] = [];
  private tokenInfo: { [mint: string]: TokenInfo } = {};
  private logger: any;
  private connection: Connection;

  constructor(
    config: PaperTradingConfig,
    connection: Connection,
    tokenInfo: { [mint: string]: TokenInfo },
    logger: any
  ) {
    this.config = config;
    this.connection = connection;
    this.tokenInfo = tokenInfo;
    this.logger = logger;

    // Initialize balances from config
    this.balances = { ...this.config.initialBalance };

    // Create record directory if it doesn't exist
    if (!fs.existsSync(this.config.recordDirectory)) {
      fs.mkdirSync(this.config.recordDirectory, { recursive: true });
    }

    // Initial balance history record
    this.recordBalance();

    this.logger.info('Paper trading mode initialized');
    this.logger.info('Initial balances:');
    Object.entries(this.balances).forEach(([mint, amount]) => {
      const symbol = this.tokenInfo[mint]?.symbol || mint.slice(0, 8) + '...';
      this.logger.info(`- ${symbol}: ${amount}`);
    });
  }

  // Get current balance for a token
  getBalance(tokenMint: string): number {
    return this.balances[tokenMint] || 0;
  }

  // Get all current balances
  getAllBalances(): { [tokenMint: string]: number } {
    return { ...this.balances };
  }

  // Execute a paper trade
  async executeTrade(
    opportunity: {
      route: string[];
      steps: any[];
      startAmount: number;
      endAmount: number;
      profit: number;
      profitPercentage: number;
    },
    jupiter: Jupiter
  ): Promise<TradeRecord> {
    // Create a new trade record
    const now = Date.now();

    // Simulate network latency
    if (this.config.latencyMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.config.latencyMs));
    }

    // Determine if trade will be "successful" based on configured success rate
    const isSuccessful = Math.random() < this.config.successRate;

    // Map token mints to symbols for readability
    const tokenSymbols = opportunity.route.map(mint =>
      this.tokenInfo[mint]?.symbol || mint.slice(0, 8) + '...'
    );

    // Get start and end token
    const startToken = opportunity.route[0];
    const endToken = opportunity.route[opportunity.route.length - 1];

    // Get list of DEXes used
    const dexes = opportunity.steps.map(step => step.dex || 'Unknown');

    // Apply slippage adjustment to simulate real-world conditions
    const adjustedEndAmount = opportunity.endAmount * (1 - this.config.slippageAdjustment);
    const adjustedProfit = adjustedEndAmount - opportunity.startAmount;
    const adjustedProfitPercentage = (adjustedProfit / opportunity.startAmount) * 100;

    // Simulate gas fees if enabled
    let gasUsed = 0;
    if (this.config.gasFeesSimulation) {
      // Estimate gas: ~0.00005 SOL per swap on average
      gasUsed = opportunity.steps.length * 0.00005;
    }

    // Create trade record
    const tradeRecord: TradeRecord = {
      timestamp: now,
      route: opportunity.route,
      tokenSymbols,
      startToken,
      startAmount: opportunity.startAmount,
      expectedEndAmount: opportunity.endAmount,
      adjustedEndAmount,
      profit: adjustedProfit - gasUsed,
      profitPercentage: adjustedProfitPercentage,
      gasUsed: this.config.gasFeesSimulation ? gasUsed : undefined,
      successful: isSuccessful,
      dexes,
    };

    // If trade is not successful, add a simulated failure reason
    if (!isSuccessful) {
      const failureReasons = [
        'Transaction timed out',
        'Slippage exceeded',
        'Insufficient liquidity',
        'Price changed during execution',
        'Order book was updated',
        'DEX temporarily unavailable'
      ];
      tradeRecord.failureReason = failureReasons[Math.floor(Math.random() * failureReasons.length)];
      this.logger.warn(`Paper trade failed: ${tradeRecord.failureReason}`);
    } else {
      // Update balances if trade is successful
      // Deduct initial amount
      this.balances[startToken] = (this.balances[startToken] || 0) - opportunity.startAmount;

      // Add result amount
      this.balances[endToken] = (this.balances[endToken] || 0) + adjustedEndAmount;

      // Deduct gas fees if enabled (from SOL balance)
      if (this.config.gasFeesSimulation) {
        const solMint = 'So11111111111111111111111111111111111111112'; // WSOL mint
        this.balances[solMint] = (this.balances[solMint] || 0) - gasUsed;
      }

      this.logger.info(`Paper trade executed successfully: ${tokenSymbols.join(' -> ')}`);
      this.logger.info(`Profit: ${tradeRecord.profit.toFixed(6)} (${tradeRecord.profitPercentage.toFixed(2)}%)`);
    }

    // Record trade
    this.tradeHistory.push(tradeRecord);
    this.saveTradeRecord(tradeRecord);

    // Update balance history
    this.recordBalance();

    return tradeRecord;
  }

  // Record current balance
  private async recordBalance() {
    // Get the total value in USD (would require price feeds in a real implementation)
    // This is a simplified version
    let totalValueUSD = 0;

    try {
      // Get USD value of each token
      for (const [mint, amount] of Object.entries(this.balances)) {
        if (amount <= 0) continue;

        // This would normally use price feeds or DEX data
        // For simplicity, we're using placeholder values
        const placeholder_prices = {
          'So11111111111111111111111111111111111111112': 25, // WSOL at $25
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 1, // USDC at $1
        };

        const price = placeholder_prices[mint] || 1; // Default to 1 if unknown
        totalValueUSD += amount * price;
      }
    } catch (error) {
      this.logger.error('Error calculating USD value:', error);
    }

    const balanceRecord: BalanceRecord = {
      timestamp: Date.now(),
      balances: { ...this.balances },
      totalValueUSD,
    };

    this.balanceHistory.push(balanceRecord);
    this.saveBalanceRecord(balanceRecord);
  }

  // Save trade record to file
  private saveTradeRecord(record: TradeRecord) {
    try {
      const filename = path.join(
        this.config.recordDirectory,
        `trade_${record.timestamp}.json`
      );

      fs.writeFileSync(filename, JSON.stringify(record, null, 2));
    } catch (error) {
      this.logger.error('Error saving trade record:', error);
    }
  }

  // Save balance record to file
  private saveBalanceRecord(record: BalanceRecord) {
    try {
      const filename = path.join(
        this.config.recordDirectory,
        `balance_${record.timestamp}.json`
      );

      fs.writeFileSync(filename, JSON.stringify(record, null, 2));

      // Also update the latest balance file
      const latestFilename = path.join(
        this.config.recordDirectory,
        'latest_balance.json'
      );

      fs.writeFileSync(latestFilename, JSON.stringify(record, null, 2));
    } catch (error) {
      this.logger.error('Error saving balance record:', error);
    }
  }

  // Get trade history
  getTradeHistory(): TradeRecord[] {
    return [...this.tradeHistory];
  }

  // Get balance history
  getBalanceHistory(): BalanceRecord[] {
    return [...this.balanceHistory];
  }

  // Get performance metrics
  getPerformanceMetrics() {
    // Calculate various performance metrics
    const totalTrades = this.tradeHistory.length;
    const successfulTrades = this.tradeHistory.filter(t => t.successful).length;
    const successRate = totalTrades > 0 ? successfulTrades / totalTrades : 0;

    // Calculate total profit
    let totalProfit = 0;
    let profitableTrades = 0;

    this.tradeHistory.forEach(trade => {
      if (trade.successful) {
        totalProfit += trade.profit;
        if (trade.profit > 0) {
          profitableTrades++;
        }
      }
    });

    // Get initial and current balance value
    const initialBalance = this.balanceHistory[0]?.totalValueUSD || 0;
    const currentBalance = this.balanceHistory[this.balanceHistory.length - 1]?.totalValueUSD || 0;
    const totalReturn = currentBalance - initialBalance;
    const percentReturn = initialBalance > 0 ? (totalReturn / initialBalance) * 100 : 0;

    return {
      totalTrades,
      successfulTrades,
      successRate,
      profitableTrades,
      totalProfit,
      initialBalance,
      currentBalance,
      totalReturn,
      percentReturn,
    };
  }

  // Generate a performance report
  generateReport(): string {
    const metrics = this.getPerformanceMetrics();
    const startTime = this.balanceHistory[0]?.timestamp;
    const endTime = Date.now();
    const durationMs = endTime - (startTime || endTime);
    const durationHours = durationMs / (1000 * 60 * 60);

    let report = '=== PAPER TRADING PERFORMANCE REPORT ===\n\n';

    report += `Duration: ${durationHours.toFixed(2)} hours\n`;
    report += `Total trades: ${metrics.totalTrades}\n`;
    report += `Successful trades: ${metrics.successfulTrades} (${(metrics.successRate * 100).toFixed(2)}%)\n`;
    report += `Profitable trades: ${metrics.profitableTrades} (${metrics.totalTrades > 0 ? (metrics.profitableTrades / metrics.totalTrades * 100).toFixed(2) : 0}%)\n`;
    report += `Total profit: ${metrics.totalProfit.toFixed(6)} SOL\n`;
    report += `Initial portfolio value: $${metrics.initialBalance.toFixed(2)}\n`;
    report += `Current portfolio value: $${metrics.currentBalance.toFixed(2)}\n`;
    report += `Total return: $${metrics.totalReturn.toFixed(2)} (${metrics.percentReturn.toFixed(2)}%)\n`;

    if (durationHours > 0) {
      const hourlyReturn = metrics.totalProfit / durationHours;
      report += `Average hourly profit: ${hourlyReturn.toFixed(6)} SOL\n`;

      const projectedDailyReturn = hourlyReturn * 24;
      const projectedMonthlyReturn = projectedDailyReturn * 30;
      const projectedYearlyReturn = projectedDailyReturn * 365;

      report += `Projected daily profit: ${projectedDailyReturn.toFixed(6)} SOL\n`;
      report += `Projected monthly profit: ${projectedMonthlyReturn.toFixed(6)} SOL\n`;
      report += `Projected yearly profit: ${projectedYearlyReturn.toFixed(6)} SOL\n`;
    }

    report += '\n=== CURRENT BALANCES ===\n\n';

    Object.entries(this.balances).forEach(([mint, amount]) => {
      if (amount > 0) {
        const symbol = this.tokenInfo[mint]?.symbol || mint.slice(0, 8) + '...';
        report += `${symbol}: ${amount}\n`;
      }
    });

    return report;
  }

  // Save full report to file
  saveReport() {
    try {
      const report = this.generateReport();
      const filename = path.join(
        this.config.recordDirectory,
        `report_${Date.now()}.txt`
      );

      fs.writeFileSync(filename, report);
      return filename;
    } catch (error) {
      this.logger.error('Error saving report:', error);
      return null;
    }
  }
}
