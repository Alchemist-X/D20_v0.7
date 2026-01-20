import { Connection, PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider, BN } from '@coral-xyz/anchor';
import { SocialBet } from '../target/types/social_bet';
import idl from '../target/idl/social_bet.json';
import { config } from 'dotenv';

// Load environment variables
config();

// Configuration
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || 'ATvmQTJT6JV9eYvBeyDacN9tGUKA4P5ykmxF9zK49CFr');
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || 'https://api.devnet.solana.com';

// Event types matching the Rust program
interface MarketCreatedEvent {
  market: PublicKey;
  marketId: BN;
  creator: PublicKey;
  question: string;
  optionsCount: number;
  stakeAmount: BN;
  betDeadline: BN;
  resolveTime: BN;
  challengeWindow: BN;
}

interface BetPlacedEvent {
  market: PublicKey;
  marketId: BN;
  user: PublicKey;
  optionIndex: number;
  amount: BN;
  totalUserAmount: BN;
}

interface SettlementProposedEvent {
  market: PublicKey;
  marketId: BN;
  proposer: PublicKey;
  proposedOutcome: number;
  challengeEndTime: BN;
}

interface SettlementChallengedEvent {
  market: PublicKey;
  marketId: BN;
  challenger: PublicKey;
}

interface MarketSettledEvent {
  market: PublicKey;
  marketId: BN;
  outcome: number;
  settledBy: PublicKey;
  isAdminResolution: boolean;
}

interface PrizeClaimedEvent {
  market: PublicKey;
  marketId: BN;
  user: PublicKey;
  amount: BN;
  fee: BN;
}

interface BetRefundedEvent {
  market: PublicKey;
  marketId: BN;
  user: PublicKey;
  amount: BN;
}

interface MarketCancelledEvent {
  market: PublicKey;
  marketId: BN;
  admin: PublicKey;
}

interface AdminChangedEvent {
  oldAdmin: PublicKey;
  newAdmin: PublicKey;
}

const STATUS_NAMES = ['OPEN', 'CLOSED', 'PROPOSED', 'DISPUTED', 'SETTLED', 'CANCELLED'];

function formatLamports(lamports: BN): string {
  return `${lamports.toNumber() / 1e9} SOL`;
}

function formatTimestamp(timestamp: BN): string {
  return new Date(timestamp.toNumber() * 1000).toISOString();
}

class SocialBetListener {
  private connection: Connection;
  private program: Program<SocialBet>;
  private eventListeners: number[] = [];

  constructor() {
    this.connection = new Connection(RPC_ENDPOINT, 'confirmed');
    
    // Create a dummy provider for program initialization
    const provider = new AnchorProvider(
      this.connection,
      {} as any,
      { commitment: 'confirmed' }
    );
    
    this.program = new Program(idl as SocialBet, provider);
  }

  /**
   * Start listening for all events
   */
  async startListening(): Promise<void> {
    console.log('🚀 Starting Social Bet event listener...');
    console.log(`📡 RPC Endpoint: ${RPC_ENDPOINT}`);
    console.log(`🏠 Program ID: ${PROGRAM_ID.toString()}`);
    
    try {
      // Subscribe to all events
      this.eventListeners.push(
        this.program.addEventListener('marketCreated', (event: MarketCreatedEvent) => {
          this.handleMarketCreated(event);
        })
      );

      this.eventListeners.push(
        this.program.addEventListener('betPlaced', (event: BetPlacedEvent) => {
          this.handleBetPlaced(event);
        })
      );

      this.eventListeners.push(
        this.program.addEventListener('settlementProposed', (event: SettlementProposedEvent) => {
          this.handleSettlementProposed(event);
        })
      );

      this.eventListeners.push(
        this.program.addEventListener('settlementChallenged', (event: SettlementChallengedEvent) => {
          this.handleSettlementChallenged(event);
        })
      );

      this.eventListeners.push(
        this.program.addEventListener('marketSettled', (event: MarketSettledEvent) => {
          this.handleMarketSettled(event);
        })
      );

      this.eventListeners.push(
        this.program.addEventListener('prizeClaimed', (event: PrizeClaimedEvent) => {
          this.handlePrizeClaimed(event);
        })
      );

      this.eventListeners.push(
        this.program.addEventListener('betRefunded', (event: BetRefundedEvent) => {
          this.handleBetRefunded(event);
        })
      );

      this.eventListeners.push(
        this.program.addEventListener('marketCancelled', (event: MarketCancelledEvent) => {
          this.handleMarketCancelled(event);
        })
      );

      this.eventListeners.push(
        this.program.addEventListener('adminChanged', (event: AdminChangedEvent) => {
          this.handleAdminChanged(event);
        })
      );

      console.log('✅ Event listeners started successfully');
      console.log('📦 Listening for all Social Bet events...\n');

      // Keep the process running
      process.on('SIGINT', () => {
        console.log('\n⏹️  Stopping event listeners...');
        this.stopListening();
        process.exit(0);
      });

    } catch (error) {
      console.error('❌ Error starting event listener:', error);
      throw error;
    }
  }

  /**
   * Stop all event listeners
   */
  async stopListening(): Promise<void> {
    for (const listener of this.eventListeners) {
      await this.program.removeEventListener(listener);
    }
    this.eventListeners = [];
  }

  private handleMarketCreated(event: MarketCreatedEvent): void {
    console.log('🎉 MARKET CREATED');
    console.log('=========================================');
    console.log(`🆔 Market ID: ${event.marketId.toString()}`);
    console.log(`🎯 Market Address: ${event.market.toString()}`);
    console.log(`👤 Creator: ${event.creator.toString()}`);
    console.log(`❓ Question: ${event.question}`);
    console.log(`🔢 Options Count: ${event.optionsCount}`);
    console.log(`💰 Stake Amount: ${formatLamports(event.stakeAmount)}`);
    console.log(`⏰ Bet Deadline: ${formatTimestamp(event.betDeadline)}`);
    console.log(`📅 Resolve Time: ${formatTimestamp(event.resolveTime)}`);
    console.log(`⚔️  Challenge Window: ${event.challengeWindow.toString()} seconds`);
    console.log(`🕐 Event Time: ${new Date().toISOString()}`);
    console.log('=========================================\n');
  }

  private handleBetPlaced(event: BetPlacedEvent): void {
    console.log('🎰 BET PLACED');
    console.log('=========================================');
    console.log(`🆔 Market ID: ${event.marketId.toString()}`);
    console.log(`👤 User: ${event.user.toString()}`);
    console.log(`🎯 Option Index: ${event.optionIndex}`);
    console.log(`💰 Bet Amount: ${formatLamports(event.amount)}`);
    console.log(`📊 Total User Amount: ${formatLamports(event.totalUserAmount)}`);
    console.log(`🕐 Event Time: ${new Date().toISOString()}`);
    console.log('=========================================\n');
  }

  private handleSettlementProposed(event: SettlementProposedEvent): void {
    console.log('📤 SETTLEMENT PROPOSED');
    console.log('=========================================');
    console.log(`🆔 Market ID: ${event.marketId.toString()}`);
    console.log(`👤 Proposer: ${event.proposer.toString()}`);
    console.log(`🎯 Proposed Outcome: Option ${event.proposedOutcome}`);
    console.log(`⏰ Challenge End Time: ${formatTimestamp(event.challengeEndTime)}`);
    console.log(`🕐 Event Time: ${new Date().toISOString()}`);
    console.log('=========================================\n');
  }

  private handleSettlementChallenged(event: SettlementChallengedEvent): void {
    console.log('⚔️  SETTLEMENT CHALLENGED');
    console.log('=========================================');
    console.log(`🆔 Market ID: ${event.marketId.toString()}`);
    console.log(`👤 Challenger: ${event.challenger.toString()}`);
    console.log(`🕐 Event Time: ${new Date().toISOString()}`);
    console.log('=========================================\n');
  }

  private handleMarketSettled(event: MarketSettledEvent): void {
    console.log('✅ MARKET SETTLED');
    console.log('=========================================');
    console.log(`🆔 Market ID: ${event.marketId.toString()}`);
    console.log(`🏆 Final Outcome: Option ${event.outcome}`);
    console.log(`👤 Settled By: ${event.settledBy.toString()}`);
    console.log(`⚖️  Admin Resolution: ${event.isAdminResolution ? 'Yes' : 'No'}`);
    console.log(`🕐 Event Time: ${new Date().toISOString()}`);
    console.log('=========================================\n');
  }

  private handlePrizeClaimed(event: PrizeClaimedEvent): void {
    console.log('💰 PRIZE CLAIMED');
    console.log('=========================================');
    console.log(`🆔 Market ID: ${event.marketId.toString()}`);
    console.log(`👤 User: ${event.user.toString()}`);
    console.log(`💵 Amount: ${formatLamports(event.amount)}`);
    console.log(`📊 Fee: ${formatLamports(event.fee)}`);
    console.log(`🕐 Event Time: ${new Date().toISOString()}`);
    console.log('=========================================\n');
  }

  private handleBetRefunded(event: BetRefundedEvent): void {
    console.log('↩️  BET REFUNDED');
    console.log('=========================================');
    console.log(`🆔 Market ID: ${event.marketId.toString()}`);
    console.log(`👤 User: ${event.user.toString()}`);
    console.log(`💵 Amount: ${formatLamports(event.amount)}`);
    console.log(`🕐 Event Time: ${new Date().toISOString()}`);
    console.log('=========================================\n');
  }

  private handleMarketCancelled(event: MarketCancelledEvent): void {
    console.log('🚫 MARKET CANCELLED');
    console.log('=========================================');
    console.log(`🆔 Market ID: ${event.marketId.toString()}`);
    console.log(`👤 Admin: ${event.admin.toString()}`);
    console.log(`🕐 Event Time: ${new Date().toISOString()}`);
    console.log('=========================================\n');
  }

  private handleAdminChanged(event: AdminChangedEvent): void {
    console.log('👑 ADMIN CHANGED');
    console.log('=========================================');
    console.log(`👤 Old Admin: ${event.oldAdmin.toString()}`);
    console.log(`👤 New Admin: ${event.newAdmin.toString()}`);
    console.log(`🕐 Event Time: ${new Date().toISOString()}`);
    console.log('=========================================\n');
  }

  /**
   * Get historical markets
   */
  async getHistoricalMarkets(): Promise<void> {
    console.log('📜 Fetching historical markets...');
    
    try {
      const markets = await this.program.account.market.all();
      
      console.log(`📊 Found ${markets.length} markets in total`);
      
      markets.forEach((market, index) => {
        console.log(`\n📦 Market #${market.account.id.toString()}:`);
        console.log(`   Address: ${market.publicKey.toString()}`);
        console.log(`   Question: ${market.account.question}`);
        console.log(`   Creator: ${market.account.creator.toString()}`);
        console.log(`   Options: ${market.account.options.slice(0, market.account.optionsCount).join(', ')}`);
        console.log(`   Stake Amount: ${formatLamports(market.account.stakeAmount)}`);
        console.log(`   Total Pool: ${formatLamports(market.account.totalPool)}`);
        console.log(`   Status: ${STATUS_NAMES[market.account.status]}`);
        console.log(`   Created At: ${formatTimestamp(market.account.createdAt)}`);
        console.log(`   Bet Deadline: ${formatTimestamp(market.account.betDeadline)}`);
        if (market.account.finalOutcome !== null) {
          console.log(`   Final Outcome: Option ${market.account.finalOutcome} (${market.account.options[market.account.finalOutcome]})`);
        }
      });
      
    } catch (error) {
      console.error('❌ Error fetching historical markets:', error);
    }
  }

  /**
   * Check if the program is deployed and accessible
   */
  async checkProgramStatus(): Promise<boolean> {
    try {
      const programInfo = await this.connection.getAccountInfo(PROGRAM_ID);
      if (!programInfo) {
        console.log('⚠️  Program not found. Make sure it\'s deployed.');
        return false;
      }
      
      console.log('✅ Program found');
      console.log(`   Executable: ${programInfo.executable}`);
      console.log(`   Owner: ${programInfo.owner.toString()}`);
      return true;
    } catch (error) {
      console.error('❌ Error checking program status:', error);
      return false;
    }
  }
}

// Main execution
async function main() {
  const listener = new SocialBetListener();
  
  // Check if program is deployed
  const isDeployed = await listener.checkProgramStatus();
  if (!isDeployed) {
    console.log('📝 Deploy the program first using: anchor deploy');
    return;
  }
  
  // Get historical events first (optional)
  console.log('📋 Checking for existing markets...');
  await listener.getHistoricalMarkets();
  
  // Start real-time listening
  await listener.startListening();
}

// Handle command line arguments
const args = process.argv.slice(2);
if (args.includes('--historical-only')) {
  // Only fetch historical events
  const listener = new SocialBetListener();
  listener.getHistoricalMarkets().then(() => {
    console.log('✅ Historical markets fetched. Exiting...');
    process.exit(0);
  });
} else {
  // Run the main listener
  main().catch((error) => {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  });
}
