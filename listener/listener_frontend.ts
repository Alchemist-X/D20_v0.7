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

const STATUS_NAMES = ['OPEN', 'CLOSED', 'PROPOSED', 'DISPUTED', 'SETTLED', 'CANCELLED'];

function formatLamports(lamports: BN): string {
  return `${lamports.toNumber() / 1e9} SOL`;
}

function formatTimestamp(timestamp: BN): string {
  return new Date(timestamp.toNumber() * 1000).toISOString();
}

// Market data structure for frontend consumption
interface MarketData {
  address: string;
  id: number;
  creator: string;
  question: string;
  options: string[];
  optionTotals: number[];
  optionParticipants: number[];
  stakeAmount: number;
  totalPool: number;
  betDeadline: string;
  resolveTime: string;
  challengeWindow: number;
  status: string;
  statusCode: number;
  proposedOutcome: number | null;
  proposer: string | null;
  challengeEndTime: string | null;
  finalOutcome: number | null;
  createdAt: string;
}

// UserBet data structure for frontend consumption
interface UserBetData {
  address: string;
  marketId: number;
  user: string;
  optionIndex: number;
  amount: number;
  claimed: boolean;
  betCount: number;
}

class HistoricalMarketScanner {
  private connection: Connection;
  private program: Program<SocialBet>;

  constructor(rpcEndpoint: string = RPC_ENDPOINT) {
    this.connection = new Connection(rpcEndpoint, 'confirmed');
    
    // Create a dummy provider for program initialization
    const provider = new AnchorProvider(
      this.connection,
      {} as any,
      { commitment: 'confirmed' }
    );
    
    this.program = new Program(idl as SocialBet, provider);
  }

  /**
   * Get all markets
   */
  async getAllMarkets(): Promise<MarketData[]> {
    const markets = await this.program.account.market.all();
    
    return markets.map(m => ({
      address: m.publicKey.toString(),
      id: m.account.id.toNumber(),
      creator: m.account.creator.toString(),
      question: m.account.question,
      options: m.account.options.slice(0, m.account.optionsCount),
      optionTotals: m.account.optionTotals.slice(0, m.account.optionsCount).map(t => t.toNumber()),
      optionParticipants: m.account.optionParticipants.slice(0, m.account.optionsCount),
      stakeAmount: m.account.stakeAmount.toNumber() / 1e9,
      totalPool: m.account.totalPool.toNumber() / 1e9,
      betDeadline: formatTimestamp(m.account.betDeadline),
      resolveTime: formatTimestamp(m.account.resolveTime),
      challengeWindow: m.account.challengeWindow.toNumber(),
      status: STATUS_NAMES[m.account.status],
      statusCode: m.account.status,
      proposedOutcome: m.account.proposedOutcome,
      proposer: m.account.proposer?.toString() || null,
      challengeEndTime: m.account.challengeEndTime ? formatTimestamp(m.account.challengeEndTime) : null,
      finalOutcome: m.account.finalOutcome,
      createdAt: formatTimestamp(m.account.createdAt),
    }));
  }

  /**
   * Get market by ID
   */
  async getMarketById(marketId: number): Promise<MarketData | null> {
    const [marketPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('market'), new BN(marketId).toArrayLike(Buffer, 'le', 8)],
      this.program.programId
    );

    try {
      const market = await this.program.account.market.fetch(marketPda);
      
      return {
        address: marketPda.toString(),
        id: market.id.toNumber(),
        creator: market.creator.toString(),
        question: market.question,
        options: market.options.slice(0, market.optionsCount),
        optionTotals: market.optionTotals.slice(0, market.optionsCount).map(t => t.toNumber()),
        optionParticipants: market.optionParticipants.slice(0, market.optionsCount),
        stakeAmount: market.stakeAmount.toNumber() / 1e9,
        totalPool: market.totalPool.toNumber() / 1e9,
        betDeadline: formatTimestamp(market.betDeadline),
        resolveTime: formatTimestamp(market.resolveTime),
        challengeWindow: market.challengeWindow.toNumber(),
        status: STATUS_NAMES[market.status],
        statusCode: market.status,
        proposedOutcome: market.proposedOutcome,
        proposer: market.proposer?.toString() || null,
        challengeEndTime: market.challengeEndTime ? formatTimestamp(market.challengeEndTime) : null,
        finalOutcome: market.finalOutcome,
        createdAt: formatTimestamp(market.createdAt),
      };
    } catch {
      return null;
    }
  }

  /**
   * Get user bet for a market
   */
  async getUserBet(marketId: number, userPubkey: string): Promise<UserBetData | null> {
    const user = new PublicKey(userPubkey);
    const [userBetPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('user_bet'), new BN(marketId).toArrayLike(Buffer, 'le', 8), user.toBuffer()],
      this.program.programId
    );

    try {
      const userBet = await this.program.account.userBet.fetch(userBetPda);
      
      return {
        address: userBetPda.toString(),
        marketId: userBet.marketId.toNumber(),
        user: userBet.user.toString(),
        optionIndex: userBet.optionIndex,
        amount: userBet.amount.toNumber() / 1e9,
        claimed: userBet.claimed,
        betCount: userBet.betCount,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get all bets for a market
   */
  async getMarketBets(marketId: number): Promise<UserBetData[]> {
    const bets = await this.program.account.userBet.all([
      {
        memcmp: {
          offset: 8, // After discriminator
          bytes: new BN(marketId).toArrayLike(Buffer, 'le', 8).toString('base64'),
        }
      }
    ]);

    return bets.map(b => ({
      address: b.publicKey.toString(),
      marketId: b.account.marketId.toNumber(),
      user: b.account.user.toString(),
      optionIndex: b.account.optionIndex,
      amount: b.account.amount.toNumber() / 1e9,
      claimed: b.account.claimed,
      betCount: b.account.betCount,
    }));
  }

  /**
   * Get all bets by a user
   */
  async getUserBets(userPubkey: string): Promise<UserBetData[]> {
    const user = new PublicKey(userPubkey);
    
    const bets = await this.program.account.userBet.all([
      {
        memcmp: {
          offset: 8 + 8, // After discriminator + market_id
          bytes: user.toBase58(),
        }
      }
    ]);

    return bets.map(b => ({
      address: b.publicKey.toString(),
      marketId: b.account.marketId.toNumber(),
      user: b.account.user.toString(),
      optionIndex: b.account.optionIndex,
      amount: b.account.amount.toNumber() / 1e9,
      claimed: b.account.claimed,
      betCount: b.account.betCount,
    }));
  }

  /**
   * Get config
   */
  async getConfig() {
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('config')],
      this.program.programId
    );

    try {
      const config = await this.program.account.config.fetch(configPda);
      
      return {
        admin: config.admin.toString(),
        feeVault: config.feeVault.toString(),
        createFee: config.createFee.toNumber() / 1e9,
        joinFeeBps: config.joinFeeBps,
        clearingFeeBps: config.clearingFeeBps,
        settleFeeBps: config.settleFeeBps,
        nextMarketId: config.nextMarketId.toNumber(),
      };
    } catch {
      return null;
    }
  }

  /**
   * Get active markets (OPEN or CLOSED status)
   */
  async getActiveMarkets(): Promise<MarketData[]> {
    const allMarkets = await this.getAllMarkets();
    return allMarkets.filter(m => m.statusCode === 0 || m.statusCode === 1);
  }

  /**
   * Get markets pending settlement (PROPOSED status)
   */
  async getPendingSettlementMarkets(): Promise<MarketData[]> {
    const allMarkets = await this.getAllMarkets();
    return allMarkets.filter(m => m.statusCode === 2);
  }

  /**
   * Get disputed markets
   */
  async getDisputedMarkets(): Promise<MarketData[]> {
    const allMarkets = await this.getAllMarkets();
    return allMarkets.filter(m => m.statusCode === 3);
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

export { HistoricalMarketScanner, MarketData, UserBetData };

// Main execution for standalone usage
async function main() {
  const scanner = new HistoricalMarketScanner();
  
  // Check if program is deployed
  const isDeployed = await scanner.checkProgramStatus();
  if (!isDeployed) {
    console.log('📝 Deploy the program first using: anchor deploy');
    return;
  }

  // Get config
  console.log('\n📋 Config:');
  const config = await scanner.getConfig();
  if (config) {
    console.log(JSON.stringify(config, null, 2));
  }
  
  // Get all markets
  console.log('\n📊 All Markets:');
  const markets = await scanner.getAllMarkets();
  markets.forEach((market, index) => {
    console.log(`\n📦 Market #${market.id}:`);
    console.log(`   Question: ${market.question}`);
    console.log(`   Status: ${market.status}`);
    console.log(`   Total Pool: ${market.totalPool} SOL`);
    console.log(`   Options:`);
    market.options.forEach((opt, i) => {
      console.log(`      ${i}: ${opt} - ${market.optionTotals[i] / 1e9} SOL (${market.optionParticipants[i]} participants)`);
    });
  });
  
  console.log('\n✅ Historical scan completed.');
}

// Run when executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  });
}
