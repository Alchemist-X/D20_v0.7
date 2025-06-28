import { Connection, PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider, web3, BN } from '@coral-xyz/anchor';
import { D20BinaryOptions } from '../target/types/d20_binary_options';
import idl from '../target/idl/d20_binary_options.json';
import { config } from 'dotenv';

// Load environment variables
config();

// Configuration
const PROGRAM_ID = new PublicKey('HC2L1MCeKvd9EgvjrahyGRk3FbZwBnUUz3L4BHYHKf8i');
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

class PoolCreatedListener {
  private connection: Connection;
  private program: Program<D20BinaryOptions>;

  constructor() {
    this.connection = new Connection(RPC_ENDPOINT, 'confirmed');
    
    // Create a dummy provider for program initialization
    const provider = new AnchorProvider(
      this.connection,
      {} as any,
      { commitment: 'confirmed' }
    );
    
    this.program = new Program(idl as D20BinaryOptions, provider);
  }

  /**
   * Start listening for PoolCreated events
   */
  async startListening(): Promise<void> {
    console.log('🚀 Starting PoolCreated event listener...');
    console.log(`📡 RPC Endpoint: ${RPC_ENDPOINT}`);
    console.log(`🏠 Program ID: ${PROGRAM_ID.toString()}`);
    
    try {
      // Subscribe to PoolCreated events
      const eventListener = this.program.addEventListener('poolCreated', (event: PoolCreatedEvent) => {
        this.handlePoolCreated(event);
      });

      console.log('✅ Event listener started successfully');
      console.log('📦 Listening for PoolCreated events...\n');

      // Keep the process running
      process.on('SIGINT', () => {
        console.log('\n⏹️  Stopping event listener...');
        this.program.removeEventListener(eventListener);
        process.exit(0);
      });

    } catch (error) {
      console.error('❌ Error starting event listener:', error);
      throw error;
    }
  }

  /**
   * Handle PoolCreated event
   */
  private handlePoolCreated(event: PoolCreatedEvent): void {
    console.log('🎉 NEW POOL CREATED EVENT DETECTED!');
    console.log('=========================================');
    console.log(`🏊 Pool Address: ${event.pool.toString()}`);
    console.log(`👤 Creator: ${event.creator.toString()}`);
    console.log(`🪙 Meme Token: ${event.memeToken.toString()}`);
    console.log(`🎯 Target Price: ${event.targetPrice.toString()} micro-units`);
    console.log(`💰 Initial Amount: ${event.amount.toString()} lamports (${event.amount.toNumber() / 1e9} SOL)`);
    console.log(`📈 Side: ${event.side === 0 ? 'CALL (higher)' : 'PUT (lower)'}`);
    console.log(`⏰ Expiry: ${new Date(event.expiry.toNumber() * 1000).toISOString()}`);
    console.log(`⏱️  Event Time: ${new Date().toISOString()}`);
    console.log('=========================================\n');

    // You can add custom logic here, such as:
    // - Storing the event in a database
    // - Sending notifications
    // - Triggering other automated actions
    // - Updating a UI in real-time
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

// Main execution
async function main() {
  const listener = new PoolCreatedListener();
  
  // Check if program is deployed
  const isDeployed = await listener.checkProgramStatus();
  if (!isDeployed) {
    console.log('📝 Deploy the program first using: anchor deploy --provider.cluster testnet');
    return;
  }
  
  // Get historical events first (optional)
  console.log('📋 Checking for existing pools...');
  await listener.getHistoricalEvents();
  
  // Start real-time listening
  await listener.startListening();
}

// Handle command line arguments
const args = process.argv.slice(2);
if (args.includes('--historical-only')) {
  // Only fetch historical events
  const listener = new PoolCreatedListener();
  listener.getHistoricalEvents().then(() => {
    console.log('✅ Historical events fetched. Exiting...');
    process.exit(0);
  });
} else {
  // Run the main listener
  main().catch((error) => {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  });
}