# Solana Arbitrage Bot

A TypeScript-based arbitrage trading bot for Solana that identifies and executes profitable trading opportunities across various decentralized exchanges.

## Features

- **Triangle Arbitrage**: Identifies price discrepancies across DEXes for triangular arbitrage opportunities (A → B → C → A)
- **Paper Trading Mode**: Test strategies without risking real funds
- **Mempool Monitoring**: Detect large pending swaps that might create temporary arbitrage opportunities
- **Jupiter Integration**: Leverages Jupiter Aggregator for optimal swap routes
- **Customizable Configuration**: Adjust profit thresholds, trading size, token pairs, and more
- **Performance Tracking**: Records trade history, success rates, and profitability metrics

## Prerequisites

- [Bun](https://bun.sh/) runtime (latest version)
- TypeScript
- Solana CLI (optional, for wallet setup)
- [Helius RPC](https://helius.xyz/) API key for enhanced Solana RPC access

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/solana-arbitrage-bot.git
   cd solana-arbitrage-bot
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

3. Configure your environment:
   - Create a `.env` file based on `.env.example`
   - Obtain a Helius RPC API key and add it to your `.env` file
   - Generate a Solana wallet (or use an existing one) for trading

4. Compile TypeScript (if needed):
   ```bash
   bun run build
   ```

## Configuration

Configure the bot by editing `config.ts` or setting environment variables. Key settings include:

- **RPC Connection**: URLs for Helius RPC and WebSocket connections
- **Wallet Settings**: Path to wallet key file and gas buffer amount
- **Arbitrage Parameters**: Minimum profit threshold, max trade size, route timeout, etc.
- **Token Settings**: Base pairs to use and tokens to exclude
- **Paper Trading**: Initial balances, slippage simulation, etc.

Example `.env` file:

```
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY
HELIUS_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_API_KEY
PRIVATE_KEY_PATH=./wallet-key.json
PAPER_TRADING=true
MIN_PROFIT_THRESHOLD=0.008
MAX_TRADE_SIZE=10
MONITORING_INTERVAL=5000
LOG_LEVEL=info
```

## Usage

### Start in Paper Trading Mode (Recommended for beginners)

```bash
bun run start -- start --paper-trading
```

### Start in Production Mode (Real trading)

```bash
bun run start -- start
```

### Enable Mempool Monitoring

```bash
bun run start -- start --mempool
```

### Debug Mode (Verbose logging)

```bash
bun run start -- start --debug
```

### All Options Combined

```bash
bun run start -- start --paper-trading --mempool --debug
```

### Direct Execution with Bun

```bash
bun main.ts start --paper-trading
```

## How It Works

1. **Route Generation**: The bot generates potential arbitrage routes involving major tokens (SOL, USDC, USDT) and other tokens with good liquidity.

2. **Opportunity Scanning**: For each route, the bot simulates trades using Jupiter to compute potential profits.

3. **Execution**: When a profitable opportunity exceeding the minimum threshold is found, the bot:
   - In paper trading mode: Simulates the execution with configured success rate and slippage
   - In production mode: Executes the trades on actual DEXes via Jupiter

4. **Mempool Monitoring** (if enabled): Watches for large pending swaps and quickly checks if they create arbitrage opportunities when executed.

5. **Analysis**: Tracks performance metrics and generates reports on profitability.

## Paper Trading

Paper trading mode simulates trading without using real funds. It features:

- Configurable initial token balances
- Simulated slippage and network latency
- Success rate simulation (to account for failed transactions in real trading)
- Detailed trade records and performance reports
- Gas fee estimation

To view reports:

```bash
bun run start -- paper-trading-report
```

Or directly:

```bash
bun main.ts paper-trading-report
```

## Security Considerations

- **Private Key Safety**: Store your wallet key securely, preferably in a hardware wallet
- **Start Small**: Begin with small trade sizes and increase gradually as you verify profitability
- **Risks**: Be aware of potential risks including slippage, failed transactions, and market volatility
- **Gas Costs**: Ensure your wallet has sufficient SOL for transaction fees
