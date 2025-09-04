import * as anchor from "@coral-xyz/anchor";
import { Program, web3, BN } from "@coral-xyz/anchor";
import { D20BinaryOptions } from "../target/types/d20_binary_options";
import { expect } from "chai";

describe("Binary Option Contract Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.D20BinaryOptions as Program<D20BinaryOptions>;

  // Test accounts
  let admin: web3.Keypair;
  let oracle: web3.Keypair;
  let creator: web3.Keypair;
  let user1: web3.Keypair;
  let user2: web3.Keypair;
  let user3: web3.Keypair;
  let feeVault: web3.Keypair;
  
  // PDAs
  let configPda: web3.PublicKey;
  let poolPda: web3.PublicKey;
  let creatorBetPda: web3.PublicKey;
  let user1BetPda: web3.PublicKey;
  
  // Test constants
  const MEME_TOKEN = web3.Keypair.generate().publicKey;
  const TARGET_PRICE = new BN(1000000); // 1 USDC in micro units
  const STAKE_AMOUNT = new BN(1000000000); // 1 SOL in lamports
  const CREATE_FEE = new BN(5000000); // 0.005 SOL
  const JOIN_FEE_BPS = 50; // 0.5%
  const CLEARING_FEE_BPS = 100; // 1%
  const SETTLE_FEE_BPS = 200; // 2%

  before(async () => {
    // Generate keypairs
    admin = web3.Keypair.generate();
    oracle = web3.Keypair.generate();
    creator = web3.Keypair.generate();
    user1 = web3.Keypair.generate();
    user2 = web3.Keypair.generate();
    user3 = web3.Keypair.generate();
    feeVault = web3.Keypair.generate();

    // Airdrop SOL to test accounts
    await Promise.all([
      provider.connection.requestAirdrop(admin.publicKey, 10 * web3.LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(oracle.publicKey, 2 * web3.LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(creator.publicKey, 10 * web3.LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(user1.publicKey, 10 * web3.LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(user2.publicKey, 10 * web3.LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(user3.publicKey, 10 * web3.LAMPORTS_PER_SOL),
    ]);

    // Wait for airdrops
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Find PDAs
    [configPda] = web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
  });

  describe("Configuration", () => {
    it("Should initialize config", async () => {
      await program.methods
        .initializeConfig(
          admin.publicKey,
          feeVault.publicKey,
          CREATE_FEE,
          JOIN_FEE_BPS,
          CLEARING_FEE_BPS,
          SETTLE_FEE_BPS
        )
        .accountsPartial({
          admin: admin.publicKey,
          oracle: oracle.publicKey,
        })
        .signers([admin])
        .rpc();

      const config = await program.account.config.fetch(configPda);
      expect(config.admin.toString()).to.equal(admin.publicKey.toString());
      expect(config.oracle.toString()).to.equal(oracle.publicKey.toString());
      expect(config.createFee.toString()).to.equal(CREATE_FEE.toString());
      expect(config.joinFeeBps).to.equal(JOIN_FEE_BPS);
      expect(config.clearingFeeBps).to.equal(CLEARING_FEE_BPS);
      expect(config.settleFeeBps).to.equal(SETTLE_FEE_BPS);
      expect(config.nextPoolId.toString()).to.equal("1");
    });
  });

  describe("Pool Creation", () => {
    it("Should create a binary option pool", async () => {
      const expiryTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now

      // Find pool PDA for pool ID 1
      [poolPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), new BN(1).toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      // Find creator bet PDA
      [creatorBetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), new BN(1).toArrayLike(Buffer, "le", 8), creator.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .createPool(
          MEME_TOKEN,
          TARGET_PRICE,
          new BN(expiryTime),
          STAKE_AMOUNT,
          0 // Call option
        )
        .accountsPartial({
          pool: poolPda,
          userBet: creatorBetPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      const pool = await program.account.gamblingPool.fetch(poolPda);
      expect(pool.id.toString()).to.equal("1");
      expect(pool.creator.toString()).to.equal(creator.publicKey.toString());
      expect(pool.memeToken.toString()).to.equal(MEME_TOKEN.toString());
      expect(pool.targetPrice.toString()).to.equal(TARGET_PRICE.toString());
      expect(pool.callTotalAmount.toString()).to.equal(STAKE_AMOUNT.toString());
      expect(pool.putTotalAmount.toString()).to.equal("0");
      expect(pool.callParticipants).to.equal(1);
      expect(pool.putParticipants).to.equal(0);
      expect(pool.status).to.equal(0); // Active
      expect(pool.winningSide).to.be.null;

      const creatorBet = await program.account.userBet.fetch(creatorBetPda);
      expect(creatorBet.poolId.toString()).to.equal("1");
      expect(creatorBet.user.toString()).to.equal(creator.publicKey.toString());
      expect(creatorBet.amount.toString()).to.equal(STAKE_AMOUNT.toString());
      expect(creatorBet.side).to.equal(0);
      expect(creatorBet.claimed).to.be.false;
    });

    it("Should fail to create pool with invalid expiry", async () => {
      const pastTime = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
      
      try {
        await program.methods
          .createPool(
            MEME_TOKEN,
            TARGET_PRICE,
            new BN(pastTime),
            STAKE_AMOUNT,
            0
          )
          .accountsPartial({
            creator: creator.publicKey,
            feeVault: feeVault.publicKey,
          })
          .signers([creator])
          .rpc();
        
        expect.fail("Should have failed with invalid expiry");
      } catch (error: any) {
        expect(error.error?.errorMessage || error.message).to.include("Invalid expiry time");
      }
    });
  });

  describe("Pool Joining", () => {
    it("Should allow users to join pool", async () => {
      // Find user1 bet PDA
      [user1BetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), new BN(1).toArrayLike(Buffer, "le", 8), user1.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .joinPool(
          new BN(1), // pool_id
          STAKE_AMOUNT,
          1 // Put option (opposite side)
        )
        .accountsPartial({
          pool: poolPda,
          userBet: user1BetPda,
          config: configPda,
          user: user1.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user1])
        .rpc();

      const pool = await program.account.gamblingPool.fetch(poolPda);
      expect(pool.putTotalAmount.toString()).to.equal(STAKE_AMOUNT.toString());
      expect(pool.putParticipants).to.equal(1);

      const user1Bet = await program.account.userBet.fetch(user1BetPda);
      expect(user1Bet.poolId.toString()).to.equal("1");
      expect(user1Bet.user.toString()).to.equal(user1.publicKey.toString());
      expect(user1Bet.amount.toString()).to.equal(STAKE_AMOUNT.toString());
      expect(user1Bet.side).to.equal(1);
      expect(user1Bet.claimed).to.be.false;
    });

    it("Should fail if amount too small", async () => {
      try {
        const [user2BetPda] = web3.PublicKey.findProgramAddressSync(
          [Buffer.from("user_bet"), new BN(1).toArrayLike(Buffer, "le", 8), user2.publicKey.toBuffer()],
          program.programId
        );

        await program.methods
          .joinPool(
            new BN(1),
            new BN(50000000), // 0.05 SOL - too small
            0
          )
          .accountsPartial({
            pool: poolPda,
            userBet: user2BetPda,
            config: configPda,
            user: user2.publicKey,
            feeVault: feeVault.publicKey,
          })
          .signers([user2])
          .rpc();
        
        expect.fail("Should have failed with amount too small");
      } catch (error: any) {
        expect(error.error?.errorMessage || error.message).to.include("Amount too small");
      }
    });
  });

  describe("Pool Settlement", () => {
    it("Should settle pool with oracle and verify settlement fee", async () => {
      // Record fee vault balance before settlement
      const feeVaultBalanceBefore = await provider.connection.getBalance(feeVault.publicKey);
      const poolBalanceBefore = await provider.connection.getBalance(poolPda);
      
      // Get current config to know next pool ID
      const config = await program.account.config.fetch(configPda);
      const nextPoolId = config.nextPoolId;
      
      // Create a new pool with short expiry for testing
      const shortExpiryTime = Math.floor(Date.now() / 1000) + 10; // 10 seconds
      
      const [shortPoolPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), nextPoolId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      
      const [shortCreatorBetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), nextPoolId.toArrayLike(Buffer, "le", 8), creator.publicKey.toBuffer()],
        program.programId
      );
      
      // Create pool with short expiry
      await program.methods
        .createPool(
          MEME_TOKEN,
          TARGET_PRICE,
          new BN(shortExpiryTime),
          STAKE_AMOUNT,
          0 // Call option
        )
        .accountsPartial({
          pool: shortPoolPda,
          userBet: shortCreatorBetPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();
      
      // Join the pool
      const [shortUser1BetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), nextPoolId.toArrayLike(Buffer, "le", 8), user1.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .joinPool(
          nextPoolId,
          STAKE_AMOUNT,
          1 // Put option
        )
        .accountsPartial({
          pool: shortPoolPda,
          userBet: shortUser1BetPda,
          config: configPda,
          user: user1.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user1])
        .rpc();
      
      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 12000)); // 12 seconds
      
      const finalPrice = new BN(1100000); // Above target price - call side wins
      
      // Get fee vault balance before settlement
      const feeVaultBeforeSettle = await provider.connection.getBalance(feeVault.publicKey);
      
      await program.methods
        .settlePool(finalPrice)
        .accountsPartial({
          pool: shortPoolPda,
          config: configPda,
          oracle: oracle.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([oracle])
        .rpc();

      // Verify settlement fee was correctly calculated and transferred
      const feeVaultAfterSettle = await provider.connection.getBalance(feeVault.publicKey);
      const totalStaked = STAKE_AMOUNT.add(STAKE_AMOUNT); // 2 SOL total
      const expectedSettleFee = totalStaked.mul(new BN(SETTLE_FEE_BPS)).div(new BN(10000)); // 2% of 2 SOL = 0.04 SOL
      const actualFeeCollected = feeVaultAfterSettle - feeVaultBeforeSettle;
      
      expect(actualFeeCollected).to.equal(expectedSettleFee.toNumber());

      const pool = await program.account.gamblingPool.fetch(shortPoolPda);
      expect(pool.status).to.equal(1); // Settled
      expect(pool.settledPrice.toString()).to.equal(finalPrice.toString());
      expect(pool.winningSide).to.equal(0); // Call side wins
      
      // Update PDAs for subsequent tests to use the settled pool
      poolPda = shortPoolPda;
      creatorBetPda = shortCreatorBetPda;
      user1BetPda = shortUser1BetPda;
    });

    it("Should fail settlement by non-oracle", async () => {
      // Create new pool for this test
      const expiryTime = Math.floor(Date.now() / 1000) + 10; // 10 seconds
      
      // Get current config to know next pool ID
      const config = await program.account.config.fetch(configPda);
      const nextPoolId = config.nextPoolId;
      
      const [newPoolPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), nextPoolId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      const [newCreatorBetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), nextPoolId.toArrayLike(Buffer, "le", 8), creator.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .createPool(MEME_TOKEN, TARGET_PRICE, new BN(expiryTime), STAKE_AMOUNT, 0)
        .accountsPartial({
          pool: newPoolPda,
          userBet: newCreatorBetPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 12000)); // 12 seconds

      // Try to settle with non-oracle
      try {
        await program.methods
          .settlePool(new BN(1100000))
          .accountsPartial({
            pool: newPoolPda,
            config: configPda,
            oracle: creator.publicKey, // Not the oracle
            feeVault: feeVault.publicKey,
          })
          .signers([creator])
          .rpc();
        
        expect.fail("Should have failed with unauthorized oracle");
      } catch (error: any) {
        expect(error.error?.errorMessage || error.message).to.include("Unauthorized oracle");
      }
    });
  });

  describe("Prize Claiming", () => {
    it("Should allow winner to claim prize with correct amount after settlement fee", async () => {
      const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);
      
      await program.methods
        .claimPrize()
        .accountsPartial({
          pool: poolPda,
          userBet: creatorBetPda,
          config: configPda,
          user: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      const creatorBet = await program.account.userBet.fetch(creatorBetPda);
      expect(creatorBet.claimed).to.be.true;

      const creatorBalanceAfter = await provider.connection.getBalance(creator.publicKey);
      const balanceIncrease = creatorBalanceAfter - creatorBalanceBefore;
      
      // Verify the creator received the correct amount:
      // Total pool: 2 SOL
      // Settlement fee: 0.04 SOL (2%)
      // Available for winners: 1.96 SOL
      // Creator bet 1 SOL on winning side (call), so gets all 1.96 SOL
      // Minus clearing fee: 1.96 * 1% = 0.0196 SOL
      // Net payout: 1.96 - 0.0196 = 1.9404 SOL
      const totalStaked = new BN(2000000000); // 2 SOL
      const settleFee = totalStaked.mul(new BN(200)).div(new BN(10000)); // 0.04 SOL
      const availableAfterSettle = totalStaked.sub(settleFee); // 1.96 SOL
      const clearingFee = availableAfterSettle.mul(new BN(100)).div(new BN(10000)); // 1% of 1.96 SOL
      const expectedPayout = availableAfterSettle.sub(clearingFee);
      
      expect(balanceIncrease).to.be.approximately(expectedPayout.toNumber(), 100000); // Allow small variance for tx fees
    });

    it("Should fail if non-winner tries to claim", async () => {
      try {
        await program.methods
          .claimPrize()
          .accountsPartial({
            pool: poolPda,
            userBet: user1BetPda,
            config: configPda,
            user: user1.publicKey, // Lost the bet (put side)
            feeVault: feeVault.publicKey,
          })
          .signers([user1])
          .rpc();
        
        expect.fail("Should have failed with not winner");
      } catch (error: any) {
        expect(error.error?.errorMessage || error.message).to.include("Not the winner");
      }
    });

    it("Should fail if already claimed", async () => {
      try {
        await program.methods
          .claimPrize()
          .accountsPartial({
            pool: poolPda,
            userBet: creatorBetPda,
            config: configPda,
            user: creator.publicKey,
            feeVault: feeVault.publicKey,
          })
          .signers([creator])
          .rpc();
        
        expect.fail("Should have failed with already claimed");
      } catch (error: any) {
        expect(error.error?.errorMessage || error.message).to.include("Prize already claimed");
      }
    });
  });

  describe("Settlement Fee Edge Cases", () => {
    it("Should handle zero settlement fee configuration", async () => {
      // Update config to 0% settlement fee
      await program.methods
        .updateConfig(
          feeVault.publicKey,
          CREATE_FEE,
          JOIN_FEE_BPS,
          CLEARING_FEE_BPS,
          0, // 0% settlement fee
          oracle.publicKey
        )
        .accountsPartial({
          config: configPda,
          admin: admin.publicKey,
        })
        .signers([admin])
        .rpc();

      // Get current config to know next pool ID
      const config = await program.account.config.fetch(configPda);
      const nextPoolId = config.nextPoolId;

      const shortExpiryTime = Math.floor(Date.now() / 1000) + 10; // 10 seconds
      
      const [zeroFeePoolPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), nextPoolId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      
      const [zeroFeeCreatorBetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), nextPoolId.toArrayLike(Buffer, "le", 8), creator.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .createPool(
          MEME_TOKEN,
          TARGET_PRICE,
          new BN(shortExpiryTime),
          STAKE_AMOUNT,
          0
        )
        .accountsPartial({
          pool: zeroFeePoolPda,
          userBet: zeroFeeCreatorBetPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      const feeVaultBalanceBefore = await provider.connection.getBalance(feeVault.publicKey);
      
      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 12000)); // 12 seconds
      
      await program.methods
        .settlePool(new BN(1100000))
        .accountsPartial({
          pool: zeroFeePoolPda,
          config: configPda,
          oracle: oracle.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([oracle])
        .rpc();

      const feeVaultBalanceAfter = await provider.connection.getBalance(feeVault.publicKey);
      
      // No settlement fee should be collected
      expect(feeVaultBalanceAfter).to.equal(feeVaultBalanceBefore);

      // Reset settlement fee for other tests
      await program.methods
        .updateConfig(
          feeVault.publicKey,
          CREATE_FEE,
          JOIN_FEE_BPS,
          CLEARING_FEE_BPS,
          SETTLE_FEE_BPS,
          oracle.publicKey
        )
        .accountsPartial({
          config: configPda,
          admin: admin.publicKey,
        })
        .signers([admin])
        .rpc();
    });

    it("Should handle multiple winners claiming after settlement fee deduction", async () => {
      // Get current config to know next pool ID
      const config = await program.account.config.fetch(configPda);
      const nextPoolId = config.nextPoolId;
      
      const shortExpiryTime = Math.floor(Date.now() / 1000) + 10; // 10 seconds
      
      const [multiPoolPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), nextPoolId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );
      
      // Create pool with creator on call side
      const [multiCreatorBetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), nextPoolId.toArrayLike(Buffer, "le", 8), creator.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .createPool(
          MEME_TOKEN,
          TARGET_PRICE,
          new BN(shortExpiryTime),
          STAKE_AMOUNT,
          0 // Call option
        )
        .accountsPartial({
          pool: multiPoolPda,
          userBet: multiCreatorBetPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      // User2 joins call side (same as creator)
      const [multiUser2BetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), nextPoolId.toArrayLike(Buffer, "le", 8), user2.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .joinPool(
          nextPoolId,
          STAKE_AMOUNT,
          0 // Call option (same side as creator)
        )
        .accountsPartial({
          pool: multiPoolPda,
          userBet: multiUser2BetPda,
          config: configPda,
          user: user2.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user2])
        .rpc();

      // User3 joins put side
      const [multiUser3BetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), nextPoolId.toArrayLike(Buffer, "le", 8), user3.publicKey.toBuffer()],
        program.programId
      );
      
      await program.methods
        .joinPool(
          nextPoolId,
          STAKE_AMOUNT,
          1 // Put option
        )
        .accountsPartial({
          pool: multiPoolPda,
          userBet: multiUser3BetPda,
          config: configPda,
          user: user3.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user3])
        .rpc();

      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 12000)); // 12 seconds
      
      // Settle with call side winning
      await program.methods
        .settlePool(new BN(1100000))
        .accountsPartial({
          pool: multiPoolPda,
          config: configPda,
          oracle: oracle.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([oracle])
        .rpc();

      // Both creator and user2 should be able to claim (they were on winning call side)
      const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);
      const user2BalanceBefore = await provider.connection.getBalance(user2.publicKey);

      // Creator claims
      await program.methods
        .claimPrize()
        .accountsPartial({
          pool: multiPoolPda,
          userBet: multiCreatorBetPda,
          config: configPda,
          user: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      // User2 claims
      await program.methods
        .claimPrize()
        .accountsPartial({
          pool: multiPoolPda,
          userBet: multiUser2BetPda,
          config: configPda,
          user: user2.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user2])
        .rpc();

      const creatorBalanceAfter = await provider.connection.getBalance(creator.publicKey);
      const user2BalanceAfter = await provider.connection.getBalance(user2.publicKey);

      // Both should receive approximately the same amount (they bet same amount on winning side)
      const creatorGain = creatorBalanceAfter - creatorBalanceBefore;
      const user2Gain = user2BalanceAfter - user2BalanceBefore;
      
      // Each should get roughly 50% of available prize pool after settlement fee
      expect(Math.abs(creatorGain - user2Gain)).to.be.lessThan(100000); // Should be very close
      expect(creatorGain).to.be.greaterThan(1000000000); // Should be greater than 1 SOL
    });
  });

  describe("Edge Cases", () => {
    it("Should handle put option correctly when price goes down", async () => {
      // Create put option pool where creator bets price will go down
      const expiryTime = Math.floor(Date.now() / 1000) + 10; // 10 seconds
      
      // Get current config to know next pool ID
      const config = await program.account.config.fetch(configPda);
      const nextPoolId = config.nextPoolId;
      
      const [putPoolPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), nextPoolId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      const [putCreatorBetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), nextPoolId.toArrayLike(Buffer, "le", 8), creator.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .createPool(MEME_TOKEN, TARGET_PRICE, new BN(expiryTime), STAKE_AMOUNT, 1) // Put option
        .accountsPartial({
          pool: putPoolPda,
          userBet: putCreatorBetPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      // User1 joins the call side
      const [putUser1BetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), nextPoolId.toArrayLike(Buffer, "le", 8), user1.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .joinPool(nextPoolId, STAKE_AMOUNT, 0) // Call option
        .accountsPartial({
          pool: putPoolPda,
          userBet: putUser1BetPda,
          config: configPda,
          user: user1.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user1])
        .rpc();

      // Wait for expiry
      await new Promise(resolve => setTimeout(resolve, 12000)); // 12 seconds

      // Settle with price below target (put side wins)
      const finalPrice = new BN(900000); // Below target price
      await program.methods
        .settlePool(finalPrice)
        .accountsPartial({
          pool: putPoolPda,
          config: configPda,
          oracle: oracle.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([oracle])
        .rpc();

      const pool = await program.account.gamblingPool.fetch(putPoolPda);
      expect(pool.winningSide).to.equal(1); // Put side wins
    });
  });

  describe("Pool Cancellation", () => {
    it("Should allow admin to cancel pool", async () => {
      // Create a new pool for cancellation testing
      const expiryTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      
      // Get current config to know next pool ID
      const config = await program.account.config.fetch(configPda);
      const nextPoolId = config.nextPoolId;
      
      const [cancelPoolPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), nextPoolId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      const [cancelCreatorBetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), nextPoolId.toArrayLike(Buffer, "le", 8), creator.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .createPool(MEME_TOKEN, TARGET_PRICE, new BN(expiryTime), STAKE_AMOUNT, 0)
        .accountsPartial({
          pool: cancelPoolPda,
          userBet: cancelCreatorBetPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      // Verify pool is active
      let pool = await program.account.gamblingPool.fetch(cancelPoolPda);
      expect(pool.status).to.equal(0); // Active

      // Admin cancels the pool (empty pool - no participants to refund)
      await program.methods
        .cancelPool()
        .accountsPartial({
          pool: cancelPoolPda,
          config: configPda,
          admin: admin.publicKey,
        })
        .remainingAccounts([
          { pubkey: cancelCreatorBetPda, isSigner: false, isWritable: true },  // creator bet account
          { pubkey: creator.publicKey, isSigner: false, isWritable: true },    // creator account
        ])
        .signers([admin])
        .rpc();

      // Verify pool is cancelled
      pool = await program.account.gamblingPool.fetch(cancelPoolPda);
      expect(pool.status).to.equal(2); // Cancelled
    });

    it("Should fail when non-admin tries to cancel pool", async () => {
      // Create a new pool for testing
      const expiryTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      
      // Get current config to know next pool ID
      const config = await program.account.config.fetch(configPda);
      const nextPoolId = config.nextPoolId;
      
      const [unauthorizedPoolPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), nextPoolId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      const [unauthorizedCreatorBetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), nextPoolId.toArrayLike(Buffer, "le", 8), creator.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .createPool(MEME_TOKEN, TARGET_PRICE, new BN(expiryTime), STAKE_AMOUNT, 0)
        .accountsPartial({
          pool: unauthorizedPoolPda,
          userBet: unauthorizedCreatorBetPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      // Try to cancel with creator (should fail - no longer allowed)
      try {
        await program.methods
          .cancelPool()
          .accountsPartial({
            pool: unauthorizedPoolPda,
            config: configPda,
            admin: creator.publicKey, // Creator is not admin
          })
          .remainingAccounts([
            { pubkey: unauthorizedCreatorBetPda, isSigner: false, isWritable: true },
            { pubkey: creator.publicKey, isSigner: false, isWritable: true },
          ])
          .signers([creator])
          .rpc();
        
        expect.fail("Should have failed with NotAdmin error");
      } catch (error: any) {
        expect(error.error?.errorMessage || error.message).to.include("Not the admin");
      }

      // Try to cancel with another user (should fail)
      try {
        await program.methods
          .cancelPool()
          .accountsPartial({
            pool: unauthorizedPoolPda,
            config: configPda,
            admin: user1.publicKey, // User1 is not admin
          })
          .remainingAccounts([
            { pubkey: unauthorizedCreatorBetPda, isSigner: false, isWritable: true },
            { pubkey: creator.publicKey, isSigner: false, isWritable: true },
          ])
          .signers([user1])
          .rpc();
        
        expect.fail("Should have failed with NotAdmin error");
      } catch (error: any) {
        expect(error.error?.errorMessage || error.message).to.include("Not the admin");
      }
    });

    it("Should fail to cancel pool that is not active", async () => {
      // Create and settle a pool first
      const expiryTime = Math.floor(Date.now() / 1000) + 10; // 10 seconds
      
      // Get current config to know next pool ID
      const config = await program.account.config.fetch(configPda);
      const nextPoolId = config.nextPoolId;
      
      const [settledPoolPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), nextPoolId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      const [settledCreatorBetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), nextPoolId.toArrayLike(Buffer, "le", 8), creator.publicKey.toBuffer()],
        program.programId
      );

      await program.methods
        .createPool(MEME_TOKEN, TARGET_PRICE, new BN(expiryTime), STAKE_AMOUNT, 0)
        .accountsPartial({
          pool: settledPoolPda,
          userBet: settledCreatorBetPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      // Wait for expiry and settle
      await new Promise(resolve => setTimeout(resolve, 12000)); // 12 seconds
      
      await program.methods
        .settlePool(new BN(1100000))
        .accountsPartial({
          pool: settledPoolPda,
          config: configPda,
          oracle: oracle.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([oracle])
        .rpc();

      // Try to cancel settled pool (should fail)
      try {
        await program.methods
          .cancelPool()
          .accountsPartial({
            pool: settledPoolPda,
            config: configPda,
            admin: admin.publicKey,
          })
          .remainingAccounts([
            { pubkey: settledCreatorBetPda, isSigner: false, isWritable: true },
            { pubkey: creator.publicKey, isSigner: false, isWritable: true },
          ])
          .signers([admin])
          .rpc();
        
        expect.fail("Should have failed with PoolNotActive error");
      } catch (error: any) {
        expect(error.error?.errorMessage || error.message).to.include("Pool not active");
      }
    });

    it("Should allow multiple participants to claim refunds after cancellation", async () => {
      // Create a new pool for cancellation testing
      const expiryTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      
      // Get current config to know next pool ID
      const config = await program.account.config.fetch(configPda);
      const nextPoolId = config.nextPoolId;
      
      const [refundPoolPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), nextPoolId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      const [refundCreatorBetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), nextPoolId.toArrayLike(Buffer, "le", 8), creator.publicKey.toBuffer()],
        program.programId
      );

      const [refundUser1BetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), nextPoolId.toArrayLike(Buffer, "le", 8), user1.publicKey.toBuffer()],
        program.programId
      );

      const [refundUser2BetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), nextPoolId.toArrayLike(Buffer, "le", 8), user2.publicKey.toBuffer()],
        program.programId
      );

      // Create pool with creator
      await program.methods
        .createPool(MEME_TOKEN, TARGET_PRICE, new BN(expiryTime), STAKE_AMOUNT, 0)
        .accountsPartial({
          pool: refundPoolPda,
          userBet: refundCreatorBetPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      // User1 joins on opposite side
      await program.methods
        .joinPool(nextPoolId, STAKE_AMOUNT, 1) // Put side
        .accountsPartial({
          pool: refundPoolPda,
          userBet: refundUser1BetPda,
          config: configPda,
          user: user1.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user1])
        .rpc();

      // User2 joins on same side as creator
      await program.methods
        .joinPool(nextPoolId, STAKE_AMOUNT, 0) // Call side
        .accountsPartial({
          pool: refundPoolPda,
          userBet: refundUser2BetPda,
          config: configPda,
          user: user2.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user2])
        .rpc();

      // Record balances before cancellation
      const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);
      const user1BalanceBefore = await provider.connection.getBalance(user1.publicKey);
      const user2BalanceBefore = await provider.connection.getBalance(user2.publicKey);

      // Admin cancels the pool and refunds all participants in one transaction
      await program.methods
        .cancelPool()
        .accountsPartial({
          pool: refundPoolPda,
          config: configPda,
          admin: admin.publicKey,
        })
        .remainingAccounts([
          { pubkey: refundCreatorBetPda, isSigner: false, isWritable: true },  // creator bet account
          { pubkey: creator.publicKey, isSigner: false, isWritable: true },    // creator account
          { pubkey: refundUser1BetPda, isSigner: false, isWritable: true },    // user1 bet account  
          { pubkey: user1.publicKey, isSigner: false, isWritable: true },      // user1 account
          { pubkey: refundUser2BetPda, isSigner: false, isWritable: true },    // user2 bet account
          { pubkey: user2.publicKey, isSigner: false, isWritable: true },      // user2 account
        ])
        .signers([admin])
        .rpc();

      // Verify pool is cancelled
      let pool = await program.account.gamblingPool.fetch(refundPoolPda);
      expect(pool.status).to.equal(2); // Cancelled status

      // Verify all user bets are marked as claimed
      const creatorBet = await program.account.userBet.fetch(refundCreatorBetPda);
      const user1Bet = await program.account.userBet.fetch(refundUser1BetPda);
      const user2Bet = await program.account.userBet.fetch(refundUser2BetPda);
      
      expect(creatorBet.claimed).to.be.true;
      expect(user1Bet.claimed).to.be.true;
      expect(user2Bet.claimed).to.be.true;

      // Verify balances increased (approximately - accounting for gas fees)
      const creatorBalanceAfter = await provider.connection.getBalance(creator.publicKey);
      const user1BalanceAfter = await provider.connection.getBalance(user1.publicKey);
      const user2BalanceAfter = await provider.connection.getBalance(user2.publicKey);

      // Each user should have received close to their original stake back
      expect(creatorBalanceAfter - creatorBalanceBefore).to.be.greaterThan(STAKE_AMOUNT.toNumber() * 0.9); // Allow for some gas fees
      expect(user1BalanceAfter - user1BalanceBefore).to.be.greaterThan(STAKE_AMOUNT.toNumber() * 0.9);
      expect(user2BalanceAfter - user2BalanceBefore).to.be.greaterThan(STAKE_AMOUNT.toNumber() * 0.9);
    });

    it("Should handle empty pool cancellation correctly", async () => {
      // Create a pool with only creator (no other participants)
      const expiryTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      
      const config = await program.account.config.fetch(configPda);
      const nextPoolId = config.nextPoolId;
      
      const [emptyPoolPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("pool"), nextPoolId.toArrayLike(Buffer, "le", 8)],
        program.programId
      );

      const [emptyCreatorBetPda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("user_bet"), nextPoolId.toArrayLike(Buffer, "le", 8), creator.publicKey.toBuffer()],
        program.programId
      );

      const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);

      await program.methods
        .createPool(MEME_TOKEN, TARGET_PRICE, new BN(expiryTime), STAKE_AMOUNT, 0)
        .accountsPartial({
          pool: emptyPoolPda,
          userBet: emptyCreatorBetPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      // Admin cancels the pool with only creator
      await program.methods
        .cancelPool()
        .accountsPartial({
          pool: emptyPoolPda,
          config: configPda,
          admin: admin.publicKey,
        })
        .remainingAccounts([
          { pubkey: emptyCreatorBetPda, isSigner: false, isWritable: true },
          { pubkey: creator.publicKey, isSigner: false, isWritable: true },
        ])
        .signers([admin])
        .rpc();

      // Verify pool is cancelled and creator's bet is marked as claimed
      const pool = await program.account.gamblingPool.fetch(emptyPoolPda);
      const creatorBet = await program.account.userBet.fetch(emptyCreatorBetPda);
      
      expect(pool.status).to.equal(2); // Cancelled status
      expect(creatorBet.claimed).to.be.true;

      // Verify creator received their refund (approximately)
      const creatorBalanceAfter = await provider.connection.getBalance(creator.publicKey);
      expect(creatorBalanceAfter - creatorBalanceBefore).to.be.greaterThan(STAKE_AMOUNT.toNumber() * 0.9);
    });
  });
});