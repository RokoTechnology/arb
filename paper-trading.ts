// paper-trading.ts - Paper trading simulation for the Solana arbitrage bot
import { Connection } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { JupiterAPI } from './jupiter-api';

// Paper trading configuration interface
interface PaperTradingConfig {
  enabled: boolean;
  initialBalances: { [tokenMint: string]: number };
  gasFee: number; // Simulated gas fee per transaction
  slippageVariation: number; // Random slippage variation percentage
  reportDir: string;
}

// Trade history interface
interface TradeHistory {
  timestamp: number;
  route: string[];
  startAmount: number;
  endAmount: number;
  profit: number;
  profitPercentage: number;
  gasFees: number;
  netProfit: number;
  balances: { [tokenMint: string]: number };
}

export class PaperTrading {
  private config: PaperTradingConfig;
  private connection: Connection;
  private tokenInfo: any;
  private logger: any;

  // Current token balances
  private balances: { [tokenMint: string]: number } = {};

  // Trade history
  private tradeHistory: TradeHistory[] = [];

  constructor(
    config: PaperTradingConfig,
    connection: Connection,
    tokenInfo: any,
    logger: any
  ) {
    this.config = config;
    this.connection = connection;
    this.tokenInfo = tokenInfo;
    this.logger = logger;

    // Initialize token balances
    this.balances = { ...config.initialBalances };

    this.logger.info('Paper trading initialized with balances:');
    Object.entries(this.balances).forEach(([mint, balance]) => {
      const symbol = this.tokenInfo[mint]?.symbol || mint.substring(0, 8);
      this.logger.info(`- ${symbol}: ${balance}`);
    });
  }

  // Get balance for a token
  getBalance(tokenMint: string): number {
    return this.balances[tokenMint] || 0;
  }

  // Set balance for a token
  setBalance(tokenMint: string, amount: number): void {
    this.balances[tokenMint] = amount;
  }

  // Execute a paper trade
  async executeTrade(
    opportunity: any,
    jupiterApi: JupiterAPI
  ): Promise<any> {
    try {
      this.logger.info('Executing paper trade...');

      // Check if we have sufficient balance
      const startToken = opportunity.route[0];
      if (this.getBalance(startToken) < opportunity.startAmount) {
        this.logger.warn(`Insufficient paper balance for ${this.tokenInfo[startToken]?.symbol || startToken}`);
        return { success: false, reason: 'insufficient_balance' };
      }

      // Simulated gas fees for the trade
      const gasFeesSOL = this.config.gasFee * (opportunity.steps.length);
      this.logger.info(`Estimated gas fees: ${gasFeesSOL.toFixed(6)} SOL`);

      // Reduce SOL balance by gas fee
      const solMint = 'So11111111111111111111111111111111111111112';
      this.balances[solMint] -= gasFeesSOL;

      // Apply the paper trade
      let currentToken = startToken;
      let currentAmount = opportunity.startAmount;

      // Reduce initial token balance
      this.balances[currentToken] -= currentAmount;

      // Simulate each swap
      for (const step of opportunity.steps) {
        const inputMint = step.inputMint;
        const outputMint = step.outputMint;

        // Apply random slippage variation if configured
        let outputAmount = step.outputAmount;
        if (this.config.slippageVariation > 0) {
          // Calculate random slippage between 0 and slippageVariation
          const slippageFactor = 1 - (Math.random() * this.config.slippageVariation / 100);
          outputAmount *= slippageFactor;
          this.logger.debug(`Applied slippage variation: ${((1 - slippageFactor) * 100).toFixed(2)}%`);
        }

        // Update current tracking variables
        currentToken = outputMint;
        currentAmount = outputAmount;

        // Add to token balance
        if (!this.balances[currentToken]) {
          this.balances[currentToken] = 0;
        }
        this.balances[currentToken] += currentAmount;

        // Log the paper swap
        const inputSymbol = this.tokenInfo[inputMint]?.symbol || inputMint.substring(0, 8);
        const outputSymbol = this.tokenInfo[outputMint]?.symbol || outputMint.substring(0, 8);
        this.logger.info(`Paper swap: ${step.inputAmount.toFixed(6)} ${inputSymbol} -> ${outputAmount.toFixed(6)} ${outputSymbol}`);
      }

      // Calculate final profit
      const finalAmount = this.balances[startToken];
      const tradedAmount = opportunity.startAmount;
      const grossProfit = opportunity.profit;
      const netProfit = grossProfit - gasFeesSOL;

      // Record trade in history
      const trade: TradeHistory = {
        timestamp: Date.now(),
        route: opportunity.route.map((mint: string) => this.tokenInfo[mint]?.symbol || mint.substring(0, 8)),
        startAmount: opportunity.startAmount,
        endAmount: opportunity.endAmount,
        profit: grossProfit,
        profitPercentage: opportunity.profitPercentage,
        gasFees: gasFeesSOL,
        netProfit: netProfit,
        balances: { ...this.balances }
      };

      this.tradeHistory.push(trade);

      // Save report after each trade if directory is configured
      if (this.config.reportDir) {
        this.saveReport();
      }

      // Log results
      this.logger.info(`Paper trade complete!`);
      this.logger.info(`Gross Profit: ${grossProfit.toFixed(6)} SOL (${opportunity.profitPercentage.toFixed(2)}%)`);
      this.logger.info(`Gas Fees: ${gasFeesSOL.toFixed(6)} SOL`);
      this.logger.info(`Net Profit: ${netProfit.toFixed(6)} SOL`);

      // Log updated balances
      this.logger.info('Updated paper balances:');
      Object.entries(this.balances).forEach(([mint, balance]) => {
        const symbol = this.tokenInfo[mint]?.symbol || mint.substring(0, 8);
        if (balance > 0) {
          this.logger.info(`- ${symbol}: ${balance.toFixed(6)}`);
        }
      });

      return {
        success: true,
        grossProfit,
        netProfit,
        gasFees: gasFeesSOL
      };

    } catch (error: any) {
      this.logger.error('Error in paper trading execution:', error);
      return {
        success: false,
        reason: 'execution_error',
        error: error.message
      };
    }
  }

  // Save trading report to disk
  saveReport(): string {
    try {
      // Create report directory if it doesn't exist
      if (!fs.existsSync(this.config.reportDir)) {
        fs.mkdirSync(this.config.reportDir, { recursive: true });
      }

      // Generate report data
      const reportData = {
        generatedAt: new Date().toISOString(),
        currentBalances: Object.entries(this.balances).map(([mint, balance]) => ({
          mint,
          symbol: this.tokenInfo[mint]?.symbol || mint.substring(0, 8),
          balance
        })).filter(item => item.balance > 0),
        summary: {
          totalTrades: this.tradeHistory.length,
          totalGrossProfit: this.tradeHistory.reduce((sum, trade) => sum + trade.profit, 0),
          totalGasFees: this.tradeHistory.reduce((sum, trade) => sum + trade.gasFees, 0),
          totalNetProfit: this.tradeHistory.reduce((sum, trade) => sum + trade.netProfit, 0),
        },
        trades: this.tradeHistory
      };

      // Save to file
      const reportFileName = `paper_trading_report_${new Date().toISOString().replace(/:/g, '-')}.json`;
      const reportPath = path.join(this.config.reportDir, reportFileName);

      fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2));

      return reportPath;
    } catch (error) {
      this.logger.error('Error saving paper trading report:', error);
      return '';
    }
  }
}
