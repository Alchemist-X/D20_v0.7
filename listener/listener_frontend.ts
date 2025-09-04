import { Connection, PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider, web3, BN } from '@coral-xyz/anchor';
import { D20BinaryOptions } from '../target/types/d20_binary_options';
import idl from '../target/idl/d20_binary_options.json';
import { config } from 'dotenv';

// Load environment variables
config();

// Configuration
const PROGRAM_ID = new PublicKey(process.env.PROGRAM_ID || 'ATvmQTJT6JV9eYvBeyDacN9tGUKA4P5ykmxF9zK49CFr');
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || 'https://api.devnet.solana.com';

interface PoolCreatedEvent {
  pool: PublicKey;
  creator: PublicKey;
  memeToken: PublicKey;
  targetPrice: BN;
  amount: BN;
  side: number;
  expiry: BN;
}

class HistoricalPoolScanner {
  private connection: Connection;
  private program: Program<D20BinaryOptions>;

  constructor(rpcEndpoint: string = RPC_ENDPOINT) {
    this.connection = new Connection(rpcEndpoint, 'confirmed');
    
    // Create a dummy provider for program initialization
    const provider = new AnchorProvider(
      this.connection,
      {} as any,
      { commitment: 'confirmed' }
    );
    
    this.program = new Program(idl as D20BinaryOptions, provider);
  }

  /**
   * Get historical PoolCreated events
   */
  async getHistoricalEvents(fromSlot?: number): Promise<void> {
    console.log('📜 Fetching historical PoolCreated events...');
    
    try {
      const events = await this.program.account.gamblingPool.all();
      
      console.log(`📊 Found ${events.length} pools in total`);
      
      events.forEach((pool, index) => {
        console.log(`\n📦 Pool #${index + 1}:`);
        console.log(`   Address: ${pool.publicKey.toString()}`);
        console.log(`   ID: ${pool.account.id.toString()}`);
        console.log(`   Creator: ${pool.account.creator.toString()}`);
        console.log(`   Meme Token: ${pool.account.memeToken.toString()}`);
        console.log(`   Target Price: ${pool.account.targetPrice.toString()}`);
        console.log(`   Call Amount: ${pool.account.callTotalAmount.toString()} lamports`);
        console.log(`   Put Amount: ${pool.account.putTotalAmount.toString()} lamports`);
        console.log(`   Status: ${pool.account.status === 0 ? 'Active' : pool.account.status === 1 ? 'Settled' : 'Other'}`);
        console.log(`   Created At: ${new Date(pool.account.createdAt.toNumber() * 1000).toISOString()}`);
        console.log(`   Expiry: ${new Date(pool.account.expiry.toNumber() * 1000).toISOString()}`);
      });
      
    } catch (error) {
      console.error('❌ Error fetching historical events:', error);
    }
  }

  /**
   * Check if the program is deployed and accessible
   */
  async checkProgramStatus(): Promise<boolean> {
    try {
      const programInfo = await this.connection.getAccountInfo(PROGRAM_ID);
      if (!programInfo) {
        console.log('⚠️  Program not found on testnet. Make sure it\'s deployed.');
        return false;
      }
      
      console.log('✅ Program found on testnet');
      console.log(`   Executable: ${programInfo.executable}`);
      console.log(`   Owner: ${programInfo.owner.toString()}`);
      return true;
    } catch (error) {
      console.error('❌ Error checking program status:', error);
      return false;
    }
  }
}

export { HistoricalPoolScanner, PoolCreatedEvent };

// Main execution for standalone usage
async function main() {
  const scanner = new HistoricalPoolScanner();
  
  // Check if program is deployed
  const isDeployed = await scanner.checkProgramStatus();
  if (!isDeployed) {
    console.log('📝 Deploy the program first using: anchor deploy --provider.cluster testnet');
    return;
  }
  
  // Get historical events
  console.log('📋 Scanning for existing pools...');
  await scanner.getHistoricalEvents();
  
  console.log('✅ Historical scan completed.');
}

// Run when executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  });
}