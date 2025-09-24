import { Connection, PublicKey, Keypair, SystemProgram } from '@solana/web3.js';
import { BN, web3, Program, AnchorProvider } from '@coral-xyz/anchor';
import { PythHttpClient, getPythProgramKeyForCluster, PythConnection } from '@pythnetwork/client';
import { D20BinaryOptions } from '../target/types/d20_binary_options';
import idl from '../target/idl/d20_binary_options.json';
import fs from 'fs';

const loadKeypair = (path: string): Keypair => {
  const secretKey = JSON.parse(fs.readFileSync(path, 'utf8'));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
};

interface PoolCreatedEvent {
  pool: PublicKey;
  creator: PublicKey;
  memeToken: PublicKey;
  targetPrice: BN;
  amount: BN;
  side: number;
  expiry: BN;
}

interface PoolInfo {
  id: BN;
  creator: PublicKey;
  memeToken: PublicKey;
  targetPrice: BN;
  expiry: BN;
  status: number; // 0 = Active, 1 = Settled
  callTotalAmount: BN;
  putTotalAmount: BN;
  callParticipants: number;
  putParticipants: number;
  settledPrice?: BN;
  winningSide?: number;
}

class PoolSettler {
  private connection: Connection;
  private oracleWallet: Keypair;
  private program: Program<D20BinaryOptions>;
  private programId: PublicKey;
  private configPda: PublicKey;
  private pythConnection: PythConnection;
  private pythHttpClient: PythHttpClient;
  private activePools: Map<string, { expiry: BN; timer?: NodeJS.Timeout }> = new Map();

  constructor() {
    require('dotenv').config();
    
    const rpcUrl = process.env.RPC_ENDPOINT!;
    const oracleWalletPath = process.env.ORACLE_WALLET_PATH!;

    if (!oracleWalletPath) {
      throw new Error('ORACLE_WALLET_PATH environment variable is required. Please set it in your .env file.');
    }
    
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.oracleWallet = loadKeypair(oracleWalletPath);
    this.programId = new PublicKey(process.env.PROGRAM_ID);
    
    if (!process.env.PROGRAM_ID) {
      throw new Error('PROGRAM_ID environment variable is required. Please set it in your .env file.');
    }

    // Create a wallet interface for the provider
    const wallet = {
      publicKey: this.oracleWallet.publicKey,
      signTransaction: async (tx: any) => {
        tx.partialSign(this.oracleWallet);
        return tx;
      },
      signAllTransactions: async (txs: any[]) => {
        txs.forEach(tx => {
          tx.partialSign(this.oracleWallet);
        });
        return txs;
      },
    };
    
    // Create Anchor program instance
    const provider = new AnchorProvider(
      this.connection,
      wallet as any,
      { commitment: 'confirmed' }
    );
    this.program = new Program(idl as D20BinaryOptions, provider);
    
    // Derive config PDA
    [this.configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('config')],
      this.programId
    );

    // Initialize Pyth connections
    const pythProgramKey = getPythProgramKeyForCluster('devnet');
    this.pythConnection = new PythConnection(this.connection, pythProgramKey);
    this.pythHttpClient = new PythHttpClient(this.connection, pythProgramKey);
  }

  async start() {
    console.log('🔮 Starting Pool Settler...');
    console.log(`📡 RPC: ${this.connection.rpcEndpoint}`);
    console.log(`🔑 Oracle Wallet: ${this.oracleWallet.publicKey.toString()}`);
    console.log(`⚙️ Config PDA: ${this.configPda.toString()}`);
    
    try {
      // First, get existing active pools and set up timers for them
      await this.loadExistingPools();
      
      // Set up event listener for new pools
      const eventListener = this.program.addEventListener('poolCreated', (event: PoolCreatedEvent) => {
        this.handleNewPool(event);
      });

      console.log('✅ Event listener started successfully');
      console.log('📦 Listening for PoolCreated events and monitoring expiries...\n');

      // Keep the process running
      process.on('SIGINT', () => {
        console.log('\n⏹️  Stopping Pool Settler...');
        this.program.removeEventListener(eventListener);
        this.clearAllTimers();
        process.exit(0);
      });

      process.on('SIGTERM', () => {
        console.log('\n⏹️  Stopping Pool Settler...');
        this.program.removeEventListener(eventListener);
        this.clearAllTimers();
        process.exit(0);
      });

    } catch (error) {
      console.error('❌ Error starting pool settler:', error);
      throw error;
    }
  }

  private clearAllTimers() {
    for (const [poolAddress, poolData] of this.activePools) {
      if (poolData.timer) {
        clearTimeout(poolData.timer);
      }
    }
    this.activePools.clear();
  }

  private async loadExistingPools() {
    try {
      console.log('🔄 Loading existing active pools...');
      
      const pools = await this.program.account.gamblingPool.all();
      let activeCount = 0;
      
      for (const pool of pools) {
        // Skip already settled pools
        if (pool.account.status !== 0) {
          continue;
        }
        
        const poolAddress = pool.publicKey.toString();
        const expiry = pool.account.expiry;
        
        this.activePools.set(poolAddress, { expiry });
        this.schedulePoolSettlement(pool.publicKey, expiry);
        activeCount++;
      }
      
      console.log(`📊 Loaded ${activeCount} active pools for monitoring`);
      
    } catch (error) {
      console.error('❌ Error loading existing pools:', error);
    }
  }

  private handleNewPool(event: PoolCreatedEvent) {
    console.log('🎉 NEW POOL CREATED - SCHEDULING SETTLEMENT');
    console.log('=============================================');
    console.log(`🏊 Pool Address: ${event.pool.toString()}`);
    console.log(`⏰ Expiry: ${new Date(event.expiry.toNumber() * 1000).toISOString()}`);
    console.log('=============================================\n');

    const poolAddress = event.pool.toString();
    this.activePools.set(poolAddress, { expiry: event.expiry });
    this.schedulePoolSettlement(event.pool, event.expiry);
  }

  private schedulePoolSettlement(poolPda: PublicKey, expiry: BN) {
    const poolAddress = poolPda.toString();
    const expiryTime = expiry.toNumber() * 1000; // Convert to milliseconds
    const currentTime = Date.now();
    const timeUntilExpiry = expiryTime - currentTime;

    if (timeUntilExpiry <= 0) {
      // Pool has already expired, settle immediately
      console.log(`⚠️ Pool ${poolAddress} has already expired, settling immediately...`);
      this.settlePool(poolPda);
    } else {
      // Schedule settlement for expiry time
      const expiryDate = new Date(expiry.toNumber() * 1000);
      const localTime = expiryDate.toLocaleString();
      console.log(`⏲️ Pool ${poolAddress} scheduled for settlement in ${Math.floor(timeUntilExpiry / 1000)}s (at ${localTime})`);
      
      const timer = setTimeout(() => {
        console.log(`⏰ Pool ${poolAddress} has expired, settling now...`);
        this.settlePool(poolPda);
      }, timeUntilExpiry);
      
      // Update the pool data with the timer
      const poolData = this.activePools.get(poolAddress);
      if (poolData) {
        poolData.timer = timer;
      }
    }
  }


  private async settlePool(poolPda: PublicKey) {
    const poolAddress = poolPda.toString();
    
    try {
      // Get pool info using Anchor
      const poolInfo = await this.program.account.gamblingPool.fetch(poolPda);
      
      // Check if pool is already settled
      if (poolInfo.status !== 0) {
        console.log(`⚠️ Pool ${poolAddress} is already settled`);
        this.activePools.delete(poolAddress);
        return;
      }

      await this.settleExpiredPool(poolPda, poolInfo);
      
      // Remove from active pools after successful settlement
      this.activePools.delete(poolAddress);
      
    } catch (error) {
      console.error(`❌ Error settling pool ${poolAddress}:`, error);
      // Don't remove from active pools on error, might retry later
    }
  }

  private async settleExpiredPool(poolPda: PublicKey, poolInfo: any) {
    try {
      // Get current price from Pyth
      const currentPrice = await this.getCurrentPrice(poolInfo.memeToken);
      
      if (!currentPrice) {
        console.error(`❌ Could not get price for token ${poolInfo.memeToken.toString()}`);
        return;
      }

      console.log(`📊 Current price for pool ${poolInfo.id.toString()}: $${currentPrice.toNumber() / 1_000_000}`);
      console.log(`🎯 Target price: $${poolInfo.targetPrice.toNumber() / 1_000_000}`);
      
      // Get config data using Anchor
      const configData = await this.program.account.config.fetch(this.configPda);
      
      console.log('💫 Sending settle_pool transaction...');
      
      // Use Anchor's program method to call settle_pool
      const tx = await this.program.methods
        .settlePool(currentPrice)
        .accountsPartial({
          pool: poolPda,
          config: this.configPda,
          oracle: this.oracleWallet.publicKey,
          feeVault: configData.feeVault,
        })
        .signers([this.oracleWallet])
        .rpc();
      
      const winningSide = currentPrice.gt(poolInfo.targetPrice) ? 0 : 1; // 0 = CALL, 1 = PUT
      const winningSideStr = winningSide === 0 ? 'CALL' : 'PUT';
      
      console.log('✅ Pool settled successfully!');
      console.log(`🏆 Winning side: ${winningSideStr}`);
      console.log(`📝 Transaction: ${tx}`);
      console.log(`🔗 View on Solscan: https://solscan.io/tx/${tx}?cluster=devnet`);
      
    } catch (error) {
      console.error(`❌ Error settling pool ${poolInfo.id.toString()}:`, error);
    }
  }

  private async getCurrentPrice(memeToken: PublicKey): Promise<BN | null> {
    try {
      // For now, we'll use SOL/USD price as an example
      // In a real implementation, you'd map meme tokens to their Pyth price feeds
      
      // Get SOL/USD price feed account key (example)
      const solUsdPriceFeedAccount = 'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG'; // SOL/USD on devnet
      
      try {
        // Use PythHttpClient's getAssetPricesFromAccounts method
        const priceDataArray = await this.pythHttpClient.getAssetPricesFromAccounts([
          new PublicKey(solUsdPriceFeedAccount)
        ]);
        
        if (priceDataArray.length > 0 && priceDataArray[0].price !== undefined) {
          // Convert Pyth price to micro-units (assuming 6 decimals)
          const price = Math.floor(priceDataArray[0].price * 1_000_000);
          return new BN(price);
        }
      } catch (pythError) {
        console.log('⚠️ Pyth price fetch failed, using mock price for testing');
      }
      
      // Fallback: return a mock price for testing
      console.log('⚠️ Using mock price for testing');
      return new BN(105_000_000); // $105 in micro-units
      
    } catch (error) {
      console.error('❌ Error fetching price from Pyth:', error);
      return null;
    }
  }

}

async function main() {
  const settler = new PoolSettler();
  
  try {
    await settler.start();
  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}