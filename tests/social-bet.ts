import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SocialBet } from "../target/types/social_bet";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { assert } from "chai";

describe("Social Bet - PRD Acceptance Tests", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SocialBet as Program<SocialBet>;

  const admin = Keypair.generate();
  const creator = Keypair.generate();
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();
  const user3 = Keypair.generate();
  const feeVault = Keypair.generate();

  let configPda: PublicKey;

  const airdrop = async (publicKey: PublicKey, amount: number) => {
    const airdropTx = await provider.connection.requestAirdrop(
      publicKey,
      amount * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropTx, "confirmed");
  };

  const getMarketPda = (marketId: anchor.BN) => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("market"), marketId.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
  };

  const getUserBetPda = (marketId: anchor.BN, user: PublicKey) => {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("user_bet"), marketId.toArrayLike(Buffer, "le", 8), user.toBuffer()],
      program.programId
    )[0];
  };

  before(async () => {
    // Airdrop SOL to all accounts
    await Promise.all([
      airdrop(admin.publicKey, 10),
      airdrop(creator.publicKey, 10),
      airdrop(user1.publicKey, 10),
      airdrop(user2.publicKey, 10),
      airdrop(user3.publicKey, 10),
      airdrop(feeVault.publicKey, 1), // Small amount for rent
    ]);

    // Find config PDA
    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    // Initialize config
    await program.methods
      .initializeConfig(
        admin.publicKey,
        feeVault.publicKey,
        new anchor.BN(5000000), // create fee: 0.005 SOL
        50,   // join_fee_bps: 0.5%
        100,  // clearing_fee_bps: 1%
        200   // settle_fee_bps: 2%
      )
      .accountsPartial({
        config: configPda,
        admin: admin.publicKey,
      })
      .signers([admin])
      .rpc();

    console.log("✅ Config initialized");
  });

  describe("1. Market Creation", () => {
    it("should create a market with question and options", async () => {
      const config = await program.account.config.fetch(configPda);
      const marketId = config.nextMarketId;
      const marketPda = getMarketPda(marketId);

      const now = Math.floor(Date.now() / 1000);
      const betDeadline = now + 3600; // 1 hour
      const resolveTime = now + 7200; // 2 hours
      const challengeWindow = 300; // 5 minutes

      await program.methods
        .createMarket(
          "Will BTC reach $100k by end of 2025?",
          ["Yes", "No"],
          new anchor.BN(0.1 * LAMPORTS_PER_SOL), // 0.1 SOL stake
          new anchor.BN(betDeadline),
          new anchor.BN(resolveTime),
          new anchor.BN(challengeWindow)
        )
        .accountsPartial({
          market: marketPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      const market = await program.account.market.fetch(marketPda);
      assert.equal(market.question, "Will BTC reach $100k by end of 2025?");
      assert.equal(market.optionsCount, 2);
      assert.equal(market.options[0], "Yes");
      assert.equal(market.options[1], "No");
      assert.equal(market.stakeAmount.toNumber(), 0.1 * LAMPORTS_PER_SOL);
      assert.equal(market.status, 0); // OPEN

      console.log("✅ Market created successfully");
    });

    it("should reject market with less than 2 options", async () => {
      const config = await program.account.config.fetch(configPda);
      const marketId = config.nextMarketId;
      const marketPda = getMarketPda(marketId);

      const now = Math.floor(Date.now() / 1000);

      try {
        await program.methods
          .createMarket(
            "Single option?",
            ["Only one"],
            new anchor.BN(0.1 * LAMPORTS_PER_SOL),
            new anchor.BN(now + 3600),
            new anchor.BN(now + 7200),
            new anchor.BN(300)
          )
          .accountsPartial({
            market: marketPda,
            config: configPda,
            creator: creator.publicKey,
            feeVault: feeVault.publicKey,
          })
          .signers([creator])
          .rpc();
        assert.fail("Should have rejected single option");
      } catch (e: any) {
        assert.include(e.message, "InvalidOptionsCount");
      }
      console.log("✅ Correctly rejected invalid options count");
    });
  });

  describe("2. Betting", () => {
    let marketId: anchor.BN;
    let marketPda: PublicKey;

    before(async () => {
      // Create a market for betting tests
      const config = await program.account.config.fetch(configPda);
      marketId = config.nextMarketId;
      marketPda = getMarketPda(marketId);

      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createMarket(
          "Test Market for Betting",
          ["Option A", "Option B", "Option C"],
          new anchor.BN(0.1 * LAMPORTS_PER_SOL),
          new anchor.BN(now + 3600),
          new anchor.BN(now + 7200),
          new anchor.BN(300)
        )
        .accountsPartial({
          market: marketPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();
    });

    it("should allow user to place a bet", async () => {
      const userBetPda = getUserBetPda(marketId, user1.publicKey);

      await program.methods
        .placeBet(marketId, 0) // Bet on Option A
        .accountsPartial({
          market: marketPda,
          userBet: userBetPda,
          config: configPda,
          user: user1.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user1])
        .rpc();

      const userBet = await program.account.userBet.fetch(userBetPda);
      assert.equal(userBet.optionIndex, 0);
      assert.equal(userBet.amount.toNumber(), 0.1 * LAMPORTS_PER_SOL);
      assert.equal(userBet.betCount, 1);

      const market = await program.account.market.fetch(marketPda);
      assert.equal(market.optionTotals[0].toNumber(), 0.1 * LAMPORTS_PER_SOL);
      assert.equal(market.optionParticipants[0], 1);

      console.log("✅ User placed bet successfully");
    });

    it("should allow user to place multiple bets on same option", async () => {
      const userBetPda = getUserBetPda(marketId, user1.publicKey);

      await program.methods
        .placeBet(marketId, 0) // Bet again on Option A
        .accountsPartial({
          market: marketPda,
          userBet: userBetPda,
          config: configPda,
          user: user1.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user1])
        .rpc();

      const userBet = await program.account.userBet.fetch(userBetPda);
      assert.equal(userBet.amount.toNumber(), 0.2 * LAMPORTS_PER_SOL);
      assert.equal(userBet.betCount, 2);

      console.log("✅ User placed multiple bets on same option");
    });

    it("should reject bet on different option", async () => {
      const userBetPda = getUserBetPda(marketId, user1.publicKey);

      try {
        await program.methods
          .placeBet(marketId, 1) // Try to bet on Option B
          .accountsPartial({
            market: marketPda,
            userBet: userBetPda,
            config: configPda,
            user: user1.publicKey,
            feeVault: feeVault.publicKey,
          })
          .signers([user1])
          .rpc();
        assert.fail("Should have rejected different option");
      } catch (e: any) {
        assert.include(e.message, "CannotChangeOption");
      }

      console.log("✅ Correctly rejected changing option");
    });

    it("should allow multiple users to bet", async () => {
      const user2BetPda = getUserBetPda(marketId, user2.publicKey);
      const user3BetPda = getUserBetPda(marketId, user3.publicKey);

      // User2 bets on Option B
      await program.methods
        .placeBet(marketId, 1)
        .accountsPartial({
          market: marketPda,
          userBet: user2BetPda,
          config: configPda,
          user: user2.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user2])
        .rpc();

      // User3 bets on Option A (same as user1)
      await program.methods
        .placeBet(marketId, 0)
        .accountsPartial({
          market: marketPda,
          userBet: user3BetPda,
          config: configPda,
          user: user3.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user3])
        .rpc();

      const market = await program.account.market.fetch(marketPda);
      // Option A: user1 (0.2 SOL) + user3 (0.1 SOL) = 0.3 SOL
      assert.equal(market.optionTotals[0].toNumber(), 0.3 * LAMPORTS_PER_SOL);
      assert.equal(market.optionParticipants[0], 2);
      // Option B: user2 (0.1 SOL)
      assert.equal(market.optionTotals[1].toNumber(), 0.1 * LAMPORTS_PER_SOL);
      assert.equal(market.optionParticipants[1], 1);

      console.log("✅ Multiple users placed bets successfully");
    });
  });

  describe("3. Betting Deadline", () => {
    it("should reject bet after deadline", async () => {
      // Create a market with very short deadline
      const config = await program.account.config.fetch(configPda);
      const marketId = config.nextMarketId;
      const marketPda = getMarketPda(marketId);

      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createMarket(
          "Short deadline market",
          ["Yes", "No"],
          new anchor.BN(0.1 * LAMPORTS_PER_SOL),
          new anchor.BN(now + 2), // 2 seconds deadline
          new anchor.BN(now + 5),
          new anchor.BN(1)
        )
        .accountsPartial({
          market: marketPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      // Wait for deadline to pass
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const userBetPda = getUserBetPda(marketId, user1.publicKey);

      try {
        await program.methods
          .placeBet(marketId, 0)
          .accountsPartial({
            market: marketPda,
            userBet: userBetPda,
            config: configPda,
            user: user1.publicKey,
            feeVault: feeVault.publicKey,
          })
          .signers([user1])
          .rpc();
        assert.fail("Should have rejected bet after deadline");
      } catch (e: any) {
        assert.include(e.message, "BettingClosed");
      }

      console.log("✅ Correctly rejected bet after deadline");
    });
  });

  describe("4. Optimistic Settlement Flow", () => {
    let marketId: anchor.BN;
    let marketPda: PublicKey;

    before(async () => {
      // Create a market for settlement tests
      const config = await program.account.config.fetch(configPda);
      marketId = config.nextMarketId;
      marketPda = getMarketPda(marketId);

      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createMarket(
          "Settlement Test Market",
          ["Win", "Lose"],
          new anchor.BN(0.5 * LAMPORTS_PER_SOL),
          new anchor.BN(now + 3600), // 1 hour bet deadline (long enough for early resolution test)
          new anchor.BN(now + 7200), // 2 hours resolve time
          new anchor.BN(2) // 2 second challenge window
        )
        .accountsPartial({
          market: marketPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      // Users place bets
      const user1BetPda = getUserBetPda(marketId, user1.publicKey);
      const user2BetPda = getUserBetPda(marketId, user2.publicKey);

      await program.methods
        .placeBet(marketId, 0) // Win
        .accountsPartial({
          market: marketPda,
          userBet: user1BetPda,
          config: configPda,
          user: user1.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user1])
        .rpc();

      await program.methods
        .placeBet(marketId, 1) // Lose
        .accountsPartial({
          market: marketPda,
          userBet: user2BetPda,
          config: configPda,
          user: user2.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user2])
        .rpc();

      console.log("✅ Settlement test market created with bets");
    });

    it("should allow early settlement (before resolve time)", async () => {
      const user1BetPda = getUserBetPda(marketId, user1.publicKey);

      // Early settlement is now allowed - no need to wait for resolve_time
      await program.methods
        .initiateSettlement(marketId, 0) // Propose "Win"
        .accountsPartial({
          market: marketPda,
          userBet: user1BetPda,
          proposer: user1.publicKey,
        })
        .signers([user1])
        .rpc();

      const market = await program.account.market.fetch(marketPda);
      assert.equal(market.status, 2); // PROPOSED
      assert.equal(market.proposedOutcome, 0);
      assert.isNotNull(market.challengeEndTime);

      console.log("✅ Early settlement initiated successfully");
    });

    it("should block new bets after settlement is proposed", async () => {
      const user3BetPda = getUserBetPda(marketId, user3.publicKey);

      try {
        await program.methods
          .placeBet(marketId, 0)
          .accountsPartial({
            market: marketPda,
            userBet: user3BetPda,
            config: configPda,
            user: user3.publicKey,
            feeVault: feeVault.publicKey,
          })
          .signers([user3])
          .rpc();
        assert.fail("Should have rejected bet on proposed market");
      } catch (e: any) {
        assert.include(e.message, "MarketNotOpen");
      }

      console.log("✅ Correctly blocked bets after settlement proposed");
    });

    it("should allow challenge during challenge window", async () => {
      await program.methods
        .challengeSettlement(marketId)
        .accountsPartial({
          market: marketPda,
          challenger: user2.publicKey,
        })
        .signers([user2])
        .rpc();

      const market = await program.account.market.fetch(marketPda);
      assert.equal(market.status, 3); // DISPUTED

      console.log("✅ Settlement challenged successfully");
    });

    it("should allow admin to resolve dispute", async () => {
      await program.methods
        .resolveDispute(marketId, 0) // Admin decides "Win"
        .accountsPartial({
          market: marketPda,
          config: configPda,
          admin: admin.publicKey,
        })
        .signers([admin])
        .rpc();

      const market = await program.account.market.fetch(marketPda);
      assert.equal(market.status, 4); // SETTLED
      assert.equal(market.finalOutcome, 0);

      console.log("✅ Admin resolved dispute successfully");
    });
  });

  describe("5. Finalize Without Challenge", () => {
    let marketId: anchor.BN;
    let marketPda: PublicKey;

    before(async () => {
      const config = await program.account.config.fetch(configPda);
      marketId = config.nextMarketId;
      marketPda = getMarketPda(marketId);

      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createMarket(
          "Finalize Test Market",
          ["Alpha", "Beta"],
          new anchor.BN(0.2 * LAMPORTS_PER_SOL),
          new anchor.BN(now + 3600), // Long deadline - we'll use early resolution
          new anchor.BN(now + 7200),
          new anchor.BN(2) // 2 second challenge window
        )
        .accountsPartial({
          market: marketPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      const user1BetPda = getUserBetPda(marketId, user1.publicKey);
      const user2BetPda = getUserBetPda(marketId, user2.publicKey);

      await program.methods
        .placeBet(marketId, 0)
        .accountsPartial({
          market: marketPda,
          userBet: user1BetPda,
          config: configPda,
          user: user1.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user1])
        .rpc();

      await program.methods
        .placeBet(marketId, 1)
        .accountsPartial({
          market: marketPda,
          userBet: user2BetPda,
          config: configPda,
          user: user2.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user2])
        .rpc();
    });

    it("should finalize settlement without challenge (early resolution)", async () => {
      const user1BetPda = getUserBetPda(marketId, user1.publicKey);

      // Initiate settlement immediately (early resolution)
      await program.methods
        .initiateSettlement(marketId, 0)
        .accountsPartial({
          market: marketPda,
          userBet: user1BetPda,
          proposer: user1.publicKey,
        })
        .signers([user1])
        .rpc();

      // Wait for challenge window to end
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Finalize
      await program.methods
        .finalizeSettlement(marketId)
        .accountsPartial({
          market: marketPda,
          userBet: user1BetPda,
          caller: user1.publicKey,
        })
        .signers([user1])
        .rpc();

      const market = await program.account.market.fetch(marketPda);
      assert.equal(market.status, 4); // SETTLED
      assert.equal(market.finalOutcome, 0);

      console.log("✅ Settlement finalized without challenge (early resolution)");
    });
  });

  describe("6. Prize Distribution", () => {
    let marketId: anchor.BN;
    let marketPda: PublicKey;
    let user1BalanceBefore: number;
    let user2BalanceBefore: number;

    before(async () => {
      const config = await program.account.config.fetch(configPda);
      marketId = config.nextMarketId;
      marketPda = getMarketPda(marketId);

      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createMarket(
          "Prize Distribution Test",
          ["Winner", "Loser"],
          new anchor.BN(1 * LAMPORTS_PER_SOL),
          new anchor.BN(now + 3600), // Long deadline - using early resolution
          new anchor.BN(now + 7200),
          new anchor.BN(2)
        )
        .accountsPartial({
          market: marketPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      const user1BetPda = getUserBetPda(marketId, user1.publicKey);
      const user2BetPda = getUserBetPda(marketId, user2.publicKey);

      await program.methods
        .placeBet(marketId, 0) // Winner
        .accountsPartial({
          market: marketPda,
          userBet: user1BetPda,
          config: configPda,
          user: user1.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user1])
        .rpc();

      await program.methods
        .placeBet(marketId, 1) // Loser
        .accountsPartial({
          market: marketPda,
          userBet: user2BetPda,
          config: configPda,
          user: user2.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user2])
        .rpc();

      user1BalanceBefore = await provider.connection.getBalance(user1.publicKey);
      user2BalanceBefore = await provider.connection.getBalance(user2.publicKey);

      // Early settlement (no need to wait)
      await program.methods
        .initiateSettlement(marketId, 0)
        .accountsPartial({
          market: marketPda,
          userBet: user1BetPda,
          proposer: user1.publicKey,
        })
        .signers([user1])
        .rpc();

      // Wait for challenge window to end
      await new Promise((resolve) => setTimeout(resolve, 3000));

      await program.methods
        .finalizeSettlement(marketId)
        .accountsPartial({
          market: marketPda,
          userBet: user1BetPda,
          caller: user1.publicKey,
        })
        .signers([user1])
        .rpc();
    });

    it("should allow winner to claim prize", async () => {
      const user1BetPda = getUserBetPda(marketId, user1.publicKey);

      await program.methods
        .claimPrize(marketId)
        .accountsPartial({
          market: marketPda,
          userBet: user1BetPda,
          config: configPda,
          user: user1.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user1])
        .rpc();

      const user1BalanceAfter = await provider.connection.getBalance(user1.publicKey);
      const userBet = await program.account.userBet.fetch(user1BetPda);

      assert.isTrue(userBet.claimed);
      // Winner should have received the total pool (2 SOL) minus 1% fee
      // Expected: ~1.98 SOL gain
      const gain = user1BalanceAfter - user1BalanceBefore;
      console.log(`Winner gain: ${gain / LAMPORTS_PER_SOL} SOL`);
      assert.isTrue(gain > 0.9 * LAMPORTS_PER_SOL); // Should gain at least ~0.9 SOL (original bet back + winnings - fees)

      console.log("✅ Winner claimed prize successfully");
    });

    it("should reject claim from loser", async () => {
      const user2BetPda = getUserBetPda(marketId, user2.publicKey);

      try {
        await program.methods
          .claimPrize(marketId)
          .accountsPartial({
            market: marketPda,
            userBet: user2BetPda,
            config: configPda,
            user: user2.publicKey,
            feeVault: feeVault.publicKey,
          })
          .signers([user2])
          .rpc();
        assert.fail("Should have rejected loser claim");
      } catch (e: any) {
        assert.include(e.message, "NotWinner");
      }

      console.log("✅ Correctly rejected loser claim");
    });

    it("should reject double claim", async () => {
      const user1BetPda = getUserBetPda(marketId, user1.publicKey);

      try {
        await program.methods
          .claimPrize(marketId)
          .accountsPartial({
            market: marketPda,
            userBet: user1BetPda,
            config: configPda,
            user: user1.publicKey,
            feeVault: feeVault.publicKey,
          })
          .signers([user1])
          .rpc();
        assert.fail("Should have rejected double claim");
      } catch (e: any) {
        assert.include(e.message, "AlreadyClaimed");
      }

      console.log("✅ Correctly rejected double claim");
    });
  });

  describe("7. Admin Cancel Market", () => {
    let marketId: anchor.BN;
    let marketPda: PublicKey;

    before(async () => {
      const config = await program.account.config.fetch(configPda);
      marketId = config.nextMarketId;
      marketPda = getMarketPda(marketId);

      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createMarket(
          "Cancel Test Market",
          ["A", "B"],
          new anchor.BN(0.5 * LAMPORTS_PER_SOL),
          new anchor.BN(now + 3600),
          new anchor.BN(now + 7200),
          new anchor.BN(300)
        )
        .accountsPartial({
          market: marketPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      const user1BetPda = getUserBetPda(marketId, user1.publicKey);

      await program.methods
        .placeBet(marketId, 0)
        .accountsPartial({
          market: marketPda,
          userBet: user1BetPda,
          config: configPda,
          user: user1.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([user1])
        .rpc();
    });

    it("should allow admin to cancel market", async () => {
      await program.methods
        .adminCancelMarket(marketId)
        .accountsPartial({
          market: marketPda,
          config: configPda,
          admin: admin.publicKey,
        })
        .signers([admin])
        .rpc();

      const market = await program.account.market.fetch(marketPda);
      assert.equal(market.status, 5); // CANCELLED

      console.log("✅ Admin cancelled market successfully");
    });

    it("should allow user to claim refund from cancelled market", async () => {
      const user1BetPda = getUserBetPda(marketId, user1.publicKey);
      const balanceBefore = await provider.connection.getBalance(user1.publicKey);

      await program.methods
        .claimCancelledRefund(marketId)
        .accountsPartial({
          market: marketPda,
          userBet: user1BetPda,
          user: user1.publicKey,
        })
        .signers([user1])
        .rpc();

      const balanceAfter = await provider.connection.getBalance(user1.publicKey);
      const refund = balanceAfter - balanceBefore;

      // Should get back ~0.5 SOL (minus tx fee)
      assert.isTrue(refund > 0.4 * LAMPORTS_PER_SOL);

      console.log(`✅ User received refund: ${refund / LAMPORTS_PER_SOL} SOL`);
    });

    it("should reject non-admin cancel", async () => {
      // Create another market
      const config = await program.account.config.fetch(configPda);
      const newMarketId = config.nextMarketId;
      const newMarketPda = getMarketPda(newMarketId);

      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createMarket(
          "Another Market",
          ["X", "Y"],
          new anchor.BN(0.1 * LAMPORTS_PER_SOL),
          new anchor.BN(now + 3600),
          new anchor.BN(now + 7200),
          new anchor.BN(300)
        )
        .accountsPartial({
          market: newMarketPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      try {
        await program.methods
          .adminCancelMarket(newMarketId)
          .accountsPartial({
            market: newMarketPda,
            config: configPda,
            admin: user1.publicKey, // Not admin
          })
          .signers([user1])
          .rpc();
        assert.fail("Should have rejected non-admin cancel");
      } catch (e: any) {
        assert.include(e.message, "NotAdmin");
      }

      console.log("✅ Correctly rejected non-admin cancel");
    });
  });

  describe("8. Admin Management", () => {
    const newAdmin = Keypair.generate();

    before(async () => {
      await airdrop(newAdmin.publicKey, 5);
    });

    it("should allow admin to set new admin", async () => {
      await program.methods
        .setAdmin(newAdmin.publicKey)
        .accountsPartial({
          config: configPda,
          admin: admin.publicKey,
        })
        .signers([admin])
        .rpc();

      const config = await program.account.config.fetch(configPda);
      assert.equal(config.admin.toBase58(), newAdmin.publicKey.toBase58());

      console.log("✅ Admin changed successfully");
    });

    it("should reject set_admin from non-admin", async () => {
      const anotherUser = Keypair.generate();
      await airdrop(anotherUser.publicKey, 1);

      try {
        await program.methods
          .setAdmin(anotherUser.publicKey)
          .accountsPartial({
            config: configPda,
            admin: user1.publicKey, // Not admin
          })
          .signers([user1])
          .rpc();
        assert.fail("Should have rejected non-admin");
      } catch (e: any) {
        assert.include(e.message, "NotAdmin");
      }

      console.log("✅ Correctly rejected non-admin set_admin");
    });

    it("should reject setting admin to zero address", async () => {
      try {
        await program.methods
          .setAdmin(PublicKey.default)
          .accountsPartial({
            config: configPda,
            admin: newAdmin.publicKey,
          })
          .signers([newAdmin])
          .rpc();
        assert.fail("Should have rejected zero address");
      } catch (e: any) {
        assert.include(e.message, "InvalidAdmin");
      }

      console.log("✅ Correctly rejected zero address admin");
    });

    it("new admin can perform admin actions", async () => {
      // Create a market to cancel
      const config = await program.account.config.fetch(configPda);
      const marketId = config.nextMarketId;
      const marketPda = getMarketPda(marketId);

      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createMarket(
          "New Admin Test Market",
          ["A", "B"],
          new anchor.BN(0.1 * LAMPORTS_PER_SOL),
          new anchor.BN(now + 3600),
          new anchor.BN(now + 7200),
          new anchor.BN(300)
        )
        .accountsPartial({
          market: marketPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      // New admin should be able to cancel market
      await program.methods
        .adminCancelMarket(marketId)
        .accountsPartial({
          market: marketPda,
          config: configPda,
          admin: newAdmin.publicKey,
        })
        .signers([newAdmin])
        .rpc();

      const market = await program.account.market.fetch(marketPda);
      assert.equal(market.status, 5); // CANCELLED

      console.log("✅ New admin can perform admin actions");
    });

    it("old admin cannot perform admin actions", async () => {
      // Create another market
      const config = await program.account.config.fetch(configPda);
      const marketId = config.nextMarketId;
      const marketPda = getMarketPda(marketId);

      const now = Math.floor(Date.now() / 1000);

      await program.methods
        .createMarket(
          "Old Admin Test Market",
          ["X", "Y"],
          new anchor.BN(0.1 * LAMPORTS_PER_SOL),
          new anchor.BN(now + 3600),
          new anchor.BN(now + 7200),
          new anchor.BN(300)
        )
        .accountsPartial({
          market: marketPda,
          config: configPda,
          creator: creator.publicKey,
          feeVault: feeVault.publicKey,
        })
        .signers([creator])
        .rpc();

      // Old admin should NOT be able to cancel market
      try {
        await program.methods
          .adminCancelMarket(marketId)
          .accountsPartial({
            market: marketPda,
            config: configPda,
            admin: admin.publicKey, // Old admin
          })
          .signers([admin])
          .rpc();
        assert.fail("Should have rejected old admin");
      } catch (e: any) {
        assert.include(e.message, "NotAdmin");
      }

      console.log("✅ Old admin correctly rejected");
    });
  });
});
