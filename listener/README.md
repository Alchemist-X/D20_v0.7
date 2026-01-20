# Social Bet Listeners

Event listeners and historical scanners for the Social Bet prediction market program.

## Files

- **listener.ts** - Real-time event listener for all Social Bet events
- **listener_frontend.ts** - Historical scanner with frontend-friendly data structures

## Events Listened

The listener tracks the following events:
- `MarketCreated` - New prediction market created
- `BetPlaced` - User placed a bet on an option
- `SettlementProposed` - Settlement initiated by a bettor
- `SettlementChallenged` - Proposed settlement challenged
- `MarketSettled` - Market finalized with outcome
- `PrizeClaimed` - Winner claimed their prize
- `BetRefunded` - Bet refunded (cancelled market or expired)
- `MarketCancelled` - Admin cancelled the market
- `AdminChanged` - Admin changed

## Usage

From the project root directory:

```bash
# Listen for real-time events
yarn listen

# Fetch historical markets only
yarn listen:historical

# Scan historical data (frontend format)
yarn scan-history
```

## Environment Variables

Configure in `.env`:

```bash
PROGRAM_ID=ATvmQTJT6JV9eYvBeyDacN9tGUKA4P5ykmxF9zK49CFr
RPC_ENDPOINT=https://api.devnet.solana.com
```

## Integration with Backend

In the event handlers (e.g., `handleMarketCreated`, `handleBetPlaced`), you can:
- Store events in a database
- Send notifications (email, push, webhooks)
- Update a real-time UI via WebSocket
- Trigger automated actions

### Example: Database Integration

```typescript
private handleMarketCreated(event: MarketCreatedEvent): void {
  // Log to console
  console.log('New market:', event.marketId.toString());
  
  // Store in database
  await db.markets.create({
    id: event.marketId.toNumber(),
    address: event.market.toString(),
    question: event.question,
    creator: event.creator.toString(),
    // ... other fields
  });
  
  // Send notification
  await notificationService.notify({
    type: 'market_created',
    data: event
  });
}
```

## Frontend Scanner (listener_frontend.ts)

The `HistoricalMarketScanner` class provides methods for frontend consumption:

```typescript
import { HistoricalMarketScanner } from './listener_frontend';

const scanner = new HistoricalMarketScanner('https://api.devnet.solana.com');

// Get all markets
const markets = await scanner.getAllMarkets();

// Get specific market
const market = await scanner.getMarketById(1);

// Get user's bet on a market
const bet = await scanner.getUserBet(1, 'user-pubkey');

// Get all bets for a market
const marketBets = await scanner.getMarketBets(1);

// Get all bets by a user
const userBets = await scanner.getUserBets('user-pubkey');

// Get active markets only
const active = await scanner.getActiveMarkets();

// Get disputed markets
const disputed = await scanner.getDisputedMarkets();

// Get config
const config = await scanner.getConfig();
```
