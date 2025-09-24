import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { D20BinaryOptions } from "../target/types/d20_binary_options";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { execSync } from "child_process";
import * as fs from "fs";
import { assert } from "chai";

describe("Emergency Shutdown", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .D20BinaryOptions as Program<D20BinaryOptions>;

  const admin = Keypair.generate();
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();
  const feeVault = Keypair.generate();

  const tempAdminKeypairPath = "/tmp/admin-wallet.json";

  let initialUser1Balance: number;
  let initialUser2Balance: number;
  let configPda: PublicKey;
  let initialAdminBalance: number;

  const airdrop = async (publicKey: PublicKey, amount: number) => {
    const airdropTx = await provider.connection.requestAirdrop(
      publicKey,
      amount * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropTx, "confirmed");
  };

  before(async () => {
    // Save admin keypair to a temporary file
    fs.writeFileSync(
      tempAdminKeypairPath,
      JSON.stringify(Array.from(admin.secretKey))
    );

    // Airdrop SOL to all accounts
    await airdrop(admin.publicKey, 10);
    await airdrop(user1.publicKey, 10);
    await airdrop(user2.publicKey, 10);

    // Record initial admin balance after airdrop but before any operations
    initialAdminBalance = await provider.connection.getBalance(admin.publicKey);
    console.log(`📊 Initial admin balance: ${initialAdminBalance / LAMPORTS_PER_SOL} SOL`);

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
        50,  // join fee: 0.5%
        100, // clearing fee: 1%
        200  // settle fee: 2%
      )
      .accountsPartial({
        config: configPda,
        admin: admin.publicKey,
        oracle: admin.publicKey, // Admin is also oracle for this test
      })
      .signers([admin])
      .rpc();

    // Get current pool ID from config
    const config = await program.account.config.fetch(configPda);
    const poolId1 = config.nextPoolId;
    const poolId2 = poolId1.add(new anchor.BN(1));

    // Find pool PDAs
    const [pool1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), poolId1.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    const [pool2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), poolId2.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // Find creator bet PDAs
    const [pool1CreatorBetPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_bet"), poolId1.toArrayLike(Buffer, "le", 8), admin.publicKey.toBuffer()],
      program.programId
    );

    const [pool2CreatorBetPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_bet"), poolId2.toArrayLike(Buffer, "le", 8), admin.publicKey.toBuffer()],
      program.programId
    );

    // Create two pools
    await program.methods
      .createPool(
        Keypair.generate().publicKey, // meme_token (BTC placeholder)
        new anchor.BN(70000), // target_price
        new anchor.BN(Math.floor(Date.now() / 1000) + 3600), // expiry: 1 hour
        new anchor.BN(1 * LAMPORTS_PER_SOL), // amount: 1 SOL
        0 // side: call
      )
      .accountsPartial({
        pool: pool1Pda,
        userBet: pool1CreatorBetPda,
        config: configPda,
        creator: admin.publicKey,
        feeVault: feeVault.publicKey,
      })
      .signers([admin])
      .rpc();

    await program.methods
      .createPool(
        Keypair.generate().publicKey, // meme_token (ETH placeholder)
        new anchor.BN(4000), // target_price
        new anchor.BN(Math.floor(Date.now() / 1000) + 3600), // expiry: 1 hour
        new anchor.BN(1 * LAMPORTS_PER_SOL), // amount: 1 SOL
        0 // side: call
      )
      .accountsPartial({
        pool: pool2Pda,
        userBet: pool2CreatorBetPda,
        config: configPda,
        creator: admin.publicKey,
        feeVault: feeVault.publicKey,
      })
      .signers([admin])
      .rpc();

    // Find user bet PDAs
    const [user1BetPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_bet"), poolId1.toArrayLike(Buffer, "le", 8), user1.publicKey.toBuffer()],
      program.programId
    );

    const [user2BetPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user_bet"), poolId1.toArrayLike(Buffer, "le", 8), user2.publicKey.toBuffer()],
      program.programId
    );

    // User1 joins pool 1 (put side)
    await program.methods
      .joinPool(poolId1, new anchor.BN(1 * LAMPORTS_PER_SOL), 1) // 1 SOL, put side
      .accountsPartial({
        pool: pool1Pda,
        userBet: user1BetPda,
        config: configPda,
        user: user1.publicKey,
        feeVault: feeVault.publicKey,
      })
      .signers([user1])
      .rpc();

    // User2 joins pool 1 (put side)
    await program.methods
      .joinPool(poolId1, new anchor.BN(0.5 * LAMPORTS_PER_SOL), 1) // 0.5 SOL, put side
      .accountsPartial({
        pool: pool1Pda,
        userBet: user2BetPda,
        config: configPda,
        user: user2.publicKey,
        feeVault: feeVault.publicKey,
      })
      .signers([user2])
      .rpc();

    initialUser1Balance = await provider.connection.getBalance(user1.publicKey);
    initialUser2Balance = await provider.connection.getBalance(user2.publicKey);
  });

  after(() => {
    // Clean up temporary keypair file
    if (fs.existsSync(tempAdminKeypairPath)) {
      fs.unlinkSync(tempAdminKeypairPath);
    }
  });

  it("should close all pools and refund users", async () => {
    const poolsBefore = await program.account.gamblingPool.all();
    assert.equal(poolsBefore.length, 2, "Should have 2 pools initially");

    const betsBefore = await program.account.userBet.all();
    console.log(`Found ${betsBefore.length} bets initially`);
    assert.isAtLeast(betsBefore.length, 3, "Should have at least 3 bets initially"); // admin + user1 + user2 (could be more)

    // Execute the close-pools command
    const command = `yarn ts-node scripts/emergency-shutdown.ts close-pools`;
    execSync(command, {
      env: {
        ...process.env,
        ADMIN_KEYPAIR_PATH: tempAdminKeypairPath,
        RPC_URL: provider.connection.rpcEndpoint,
      },
      stdio: "inherit",
    });

    // Assertions
    const finalUser1Balance = await provider.connection.getBalance(user1.publicKey);
    const finalUser2Balance = await provider.connection.getBalance(user2.publicKey);

    // Check if users got their money back (approximately, considering gas fees)
    assert.isTrue(
      finalUser1Balance > initialUser1Balance,
      "User1 should have received a refund"
    );
    assert.isTrue(
      finalUser2Balance > initialUser2Balance,
      "User2 should have received a refund"
    );

    // Check that pools are still there but bets should be claimed
    const poolsAfter = await program.account.gamblingPool.all();
    assert.equal(poolsAfter.length, 2, "Pools should still exist after force-close");
  });

  it("should close all accounts", async () => {
    // Execute the close-accounts command
    const command = `yarn ts-node scripts/emergency-shutdown.ts close-accounts`;
    execSync(command, {
      env: {
        ...process.env,
        ADMIN_KEYPAIR_PATH: tempAdminKeypairPath,
        RPC_URL: provider.connection.rpcEndpoint,
      },
      stdio: "inherit",
    });

    // Assertions - all accounts should be closed
    const poolsAfter = await program.account.gamblingPool.all();
    assert.equal(poolsAfter.length, 0, "All pool accounts should be closed");

    const betsAfter = await program.account.userBet.all();
    assert.equal(betsAfter.length, 0, "All user bet accounts should be closed");

    const configsAfter = await program.account.config.all();
    assert.equal(configsAfter.length, 0, "Config account should be closed");
  });

  it("should close the program and show total SOL spent/recovered", async () => {
    // Execute the close-program command to recover program rent
    const command = `yarn ts-node scripts/emergency-shutdown.ts close-program`;
    execSync(command, {
      env: {
        ...process.env,
        ADMIN_KEYPAIR_PATH: tempAdminKeypairPath,
        RPC_URL: provider.connection.rpcEndpoint,
      },
      stdio: "inherit",
    });

    // Get final admin balance after everything is closed
    const finalAdminBalance = await provider.connection.getBalance(admin.publicKey);
    console.log(`📊 Final admin balance: ${finalAdminBalance / LAMPORTS_PER_SOL} SOL`);

    // Calculate total SOL delta (negative means spent, positive means recovered)
    const totalDelta = (finalAdminBalance - initialAdminBalance) / LAMPORTS_PER_SOL;

    if (totalDelta > 0) {
      console.log(`💰 Total SOL RECOVERED from rent: +${totalDelta.toFixed(6)} SOL`);
    } else {
      console.log(`💸 Total SOL SPENT (after rent recovery): ${Math.abs(totalDelta).toFixed(6)} SOL`);
    }

    console.log(`📈 Net change: ${totalDelta > 0 ? '+' : ''}${totalDelta.toFixed(6)} SOL`);
  });
});