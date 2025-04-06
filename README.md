# Solana Arbitrage Bot

A high-performance Solana arbitrage bot that detects and executes profitable trading opportunities across different DEXes, with built-in paper trading capabilities.

## Quick Start Commands

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/solana-arbitrage-bot.git
cd solana-arbitrage-bot

# Install dependencies
bun install

# Set up wallet (if needed)
solana-keygen new -o wallet-key.json
```

### Running the Bot

```bash
# Start the bot with paper trading enabled
bun run main.ts start --paper-trading

# Start with real trading (be careful!)
bun run main.ts start

# Start with mempool monitoring for more opportunities
bun run main.ts start --mempool --paper-trading

# Run with debug logging
bun run main.ts start --paper-trading --debug
```

### Paper Trading Commands

```bash
# Generate a paper trading performance report
bun run main.ts paper-trading-report

# Reset paper trading data
bun run main.ts paper-trading-reset

# Analyze paper trading results
bun run main.ts paper-trading-analyze

# Visualize paper trading performance
bun run main.ts paper-trading-visualize
```

### Simulation

```bash
# Simulate specific arbitrage opportunities
bun run main.ts simulate --token So11111111111111111111111111111111111111112 --amount 10

# Simulate and record to paper trading
bun run main.ts simulate --paper-trading
```

### Other Utilities

```bash
# Analyze DEXes for arbitrage potential
bun run main.ts analyze-dexes
```

## Environment Variables

```bash
# Set these environment variables to configure the bot
export HELIUS_RPC_URL="https://rpc.helius.xyz/your-api-key"
export PAPER_TRADING="true"
export MAX_TRADE_SIZE="5"
export MIN_PROFIT_THRESHOLD="0.008"
export LOG_LEVEL="debug"
export MONITORING_INTERVAL="5000"
```

## Disclaimer

This bot is provided for educational purposes only. Trading cryptocurrencies involves significant risk. Only use funds you can afford to lose.
