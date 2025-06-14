// @ts-nocheck
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { D20BinaryOptions } from "../target/types/d20_binary_options";
import { PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { expect } from 'chai';

// helper funcs
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

let provider: anchor.AnchorProvider; // will assign later
const airdrop = async (pubkey: PublicKey, lamports = 2 * LAMPORTS_PER_SOL) => {
  const sig = await provider.connection.requestAirdrop(pubkey, lamports);
  await provider.connection.confirmTransaction(sig);
};

describe("d20-binary-options", () => {
  const program = anchor.workspace.D20BinaryOptions as Program<D20BinaryOptions>;
  
  // 测试用的 meme token 地址（模拟）
  const MEME_TOKEN = new PublicKey("11111111111111111111111111111112");
  
  provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  it("Initializes the program", async () => {
    await program.methods
      .initialize()
      .accounts({})
      .rpc();
  });

  it("Creates a pool", async () => {
    const creator = Keypair.generate();
    await airdrop(creator.publicKey);

    const [poolPda] = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from("pool"), creator.publicKey.toBuffer()],
      program.programId
    );
    const targetPrice = new anchor.BN(100 * LAMPORTS_PER_SOL); // 100 SOL 等值
    const currentPrice = new anchor.BN(90 * LAMPORTS_PER_SOL); // 当前价格 90 SOL 等值
    const expiry = new anchor.BN(Math.floor(Date.now() / 1000) + 3600); // 1小时后
    const amount = new anchor.BN(1 * LAMPORTS_PER_SOL); // 1 SOL
    const side = 0; // 高于

    console.log("Creating pool...");
    console.log("Pool address:", poolPda.toString());
    console.log("Creator:", creator.publicKey.toString());

    await program.methods
      .createPool(
        MEME_TOKEN,
        targetPrice,
        currentPrice,
        expiry,
        amount,
        side
      )
      .accounts({
        pool: poolPda,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    const poolAccount = await program.account.gamblingPool.fetch(poolPda);
    
    expect(poolAccount.creator.toString()).to.equal(creator.publicKey.toString());
    expect(poolAccount.memeToken.toString()).to.equal(MEME_TOKEN.toString());
    expect(poolAccount.targetPrice.toString()).to.equal(targetPrice.toString());
    expect(poolAccount.creatorAmount.toString()).to.equal(amount.toString());
    expect(poolAccount.creatorSide).to.equal(side);
    expect(poolAccount.opponentAmount.toString()).to.equal("0");
    expect(poolAccount.status).to.equal(0);
    expect(poolAccount.winner).to.be.null;

    console.log("Pool created successfully!");
    console.log("Pool details:", {
      creator: poolAccount.creator.toString(),
      targetPrice: poolAccount.targetPrice.toString(),
      creatorAmount: poolAccount.creatorAmount.toString(),
      status: poolAccount.status
    });
  });

  it("Joins a pool", async () => {
    const creator = Keypair.generate();
    await airdrop(creator.publicKey);

    const [poolPda] = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from("pool"), creator.publicKey.toBuffer()],
      program.programId
    );
    const opponent = anchor.web3.Keypair.generate();
    const targetPrice = new anchor.BN(100 * LAMPORTS_PER_SOL);
    const currentPrice = new anchor.BN(90 * LAMPORTS_PER_SOL);
    const expiry = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
    const creatorAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const side = 0;

    await program.methods
      .createPool(
        MEME_TOKEN,
        targetPrice,
        currentPrice,
        expiry,
        creatorAmount,
        side
      )
      .accounts({
        pool: poolPda,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    // 给对手账户空投一些 SOL 用于测试
    await provider.connection.requestAirdrop(opponent.publicKey, 10 * LAMPORTS_PER_SOL);
    await new Promise(resolve => setTimeout(resolve, 1000)); // 等待空投完成

    // 对手加入池子
    const opponentAmount = new anchor.BN(1 * LAMPORTS_PER_SOL);

    console.log("Opponent joining pool...");
    console.log("Opponent address:", opponent.publicKey.toString());

    await program.methods
      .joinPool(opponentAmount)
      .accounts({
        pool: poolPda,
        opponent: opponent.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([opponent])
      .rpc();

    const poolAccount = await program.account.gamblingPool.fetch(poolPda);
    
    expect(poolAccount.opponentAmount.toString()).to.equal(opponentAmount.toString());
    expect(poolAccount.status).to.equal(0); // 仍然是进行中状态

    console.log("Opponent joined successfully!");
    console.log("Pool details after join:", {
      creatorAmount: poolAccount.creatorAmount.toString(),
      opponentAmount: poolAccount.opponentAmount.toString(),
      status: poolAccount.status
    });
  });

  it("Settles a pool - creator wins", async () => {
    const creator = Keypair.generate();
    await airdrop(creator.publicKey);

    const [poolPda] = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from("pool"), creator.publicKey.toBuffer()],
      program.programId
    );
    const opponent = anchor.web3.Keypair.generate();
    const targetPrice = new anchor.BN(100 * LAMPORTS_PER_SOL);
    const currentPrice = new anchor.BN(90 * LAMPORTS_PER_SOL);
    const shortExpiry = new anchor.BN(Math.floor(Date.now() / 1000) + 2); // 2秒后过期
    const amount = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const side = 0; // 预测价格会高于目标价格

    await program.methods
      .createPool(
        MEME_TOKEN,
        targetPrice,
        currentPrice,
        shortExpiry,
        amount,
        side
      )
      .accounts({
        pool: poolPda,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    // 给对手空投 SOL
    await provider.connection.requestAirdrop(opponent.publicKey, 10 * LAMPORTS_PER_SOL);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 对手加入
    await program.methods
      .joinPool(amount)
      .accounts({
        pool: poolPda,
        opponent: opponent.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([opponent])
      .rpc();

    // 等待池子到期
    console.log("Waiting for pool to expire...");
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 获取结算前的余额
    const creatorBalanceBefore = await provider.connection.getBalance(creator.publicKey);
    const opponentBalanceBefore = await provider.connection.getBalance(opponent.publicKey);

    console.log("Balances before settlement:");
    console.log("Creator:", creatorBalanceBefore / LAMPORTS_PER_SOL, "SOL");
    console.log("Opponent:", opponentBalanceBefore / LAMPORTS_PER_SOL, "SOL");

    // 结算池子 - 最终价格高于目标价格，创建者获胜
    const finalPrice = new anchor.BN(110 * LAMPORTS_PER_SOL); // 110 SOL，高于目标价格100

    await program.methods
      .settlePool(finalPrice)
      .accounts({
        pool: poolPda,
        creator: creator.publicKey,
        opponent: opponent.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    let poolAccount = await program.account.gamblingPool.fetch(poolPda);
    
    expect(poolAccount.status).to.equal(1); // 已结算
    expect(poolAccount.winner.toString()).to.equal(creator.publicKey.toString()); // 创建者获胜

    console.log("Pool settled successfully - Creator wins!");
    console.log("Pool details after settlement:", {
      status: poolAccount.status,
      winner: poolAccount.winner?.toString(),
      finalPrice: finalPrice.toString()
    });

    // 创建者提取奖金
    await program.methods
      .claimPrize()
      .accounts({
        pool: poolPda,
        winner: creator.publicKey,
      })
      .signers([creator])
      .rpc();

    // 获取提取奖金后的余额
    const creatorBalanceAfter = await provider.connection.getBalance(creator.publicKey);
    const opponentBalanceAfter = await provider.connection.getBalance(opponent.publicKey);

    console.log("Balances after prize claim:");
    console.log("Creator:", creatorBalanceAfter / LAMPORTS_PER_SOL, "SOL");
    console.log("Opponent:", opponentBalanceAfter / LAMPORTS_PER_SOL, "SOL");

    // 验证奖金已提取
    poolAccount = await program.account.gamblingPool.fetch(poolPda);
    expect(poolAccount.status).to.equal(2); // 已提取奖金
  });

  it("Settles a pool - opponent wins", async () => {
    const creator = Keypair.generate();
    await airdrop(creator.publicKey);

    const [poolPda] = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from("pool"), creator.publicKey.toBuffer()],
      program.programId
    );
    const opponent = anchor.web3.Keypair.generate();
    const targetPrice = new anchor.BN(100 * LAMPORTS_PER_SOL);
    const currentPrice = new anchor.BN(90 * LAMPORTS_PER_SOL);
    const shortExpiry = new anchor.BN(Math.floor(Date.now() / 1000) + 2);
    const amount = new anchor.BN(1 * LAMPORTS_PER_SOL);
    const side = 0; // 创建者预测价格会高于目标价格

    await program.methods
      .createPool(
        MEME_TOKEN,
        targetPrice,
        currentPrice,
        shortExpiry,
        amount,
        side
      )
      .accounts({
        pool: poolPda,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    // 给新对手空投 SOL
    await provider.connection.requestAirdrop(opponent.publicKey, 10 * LAMPORTS_PER_SOL);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 对手加入
    await program.methods
      .joinPool(amount)
      .accounts({
        pool: poolPda,
        opponent: opponent.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([opponent])
      .rpc();

    // 等待池子到期
    console.log("Waiting for pool to expire...");
    await new Promise(resolve => setTimeout(resolve, 3000));

    // 结算池子 - 最终价格低于目标价格，对手获胜
    const finalPrice = new anchor.BN(80 * LAMPORTS_PER_SOL); // 80 SOL，低于目标价格100

    await program.methods
      .settlePool(finalPrice)
      .accounts({
        pool: poolPda,
        creator: creator.publicKey,
        opponent: opponent.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    let poolAccount = await program.account.gamblingPool.fetch(poolPda);
    
    expect(poolAccount.status).to.equal(1); // 已结算
    expect(poolAccount.winner.toString()).to.equal(opponent.publicKey.toString()); // 对手获胜

    console.log("Pool settled successfully - Opponent wins!");
    console.log("Pool details after settlement:", {
      status: poolAccount.status,
      winner: poolAccount.winner?.toString(),
      finalPrice: finalPrice.toString()
    });

    // 对手提取奖金
    await program.methods
      .claimPrize()
      .accounts({
        pool: poolPda,
        winner: opponent.publicKey,
      })
      .signers([opponent])
      .rpc();

    // 验证奖金已提取
    poolAccount = await program.account.gamblingPool.fetch(poolPda);
    expect(poolAccount.status).to.equal(2); // 已提取奖金
  });

  it("Fails to join an already joined pool", async () => {
    const creator = Keypair.generate();
    await airdrop(creator.publicKey);

    const [poolPda] = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from("pool"), creator.publicKey.toBuffer()],
      program.programId
    );
    const firstOpponent = anchor.web3.Keypair.generate();
    const secondOpponent = anchor.web3.Keypair.generate();
    const targetPrice = new anchor.BN(100 * LAMPORTS_PER_SOL);
    const currentPrice = new anchor.BN(90 * LAMPORTS_PER_SOL);
    const expiry = new anchor.BN(Math.floor(Date.now() / 1000) + 3600);
    const amount = new anchor.BN(1 * LAMPORTS_PER_SOL);

    await program.methods
      .createPool(MEME_TOKEN, targetPrice, currentPrice, expiry, amount, 0)
      .accounts({
        pool: poolPda,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    // 空投给对手们
    await provider.connection.requestAirdrop(firstOpponent.publicKey, 10 * LAMPORTS_PER_SOL);
    await provider.connection.requestAirdrop(secondOpponent.publicKey, 10 * LAMPORTS_PER_SOL);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 第一个对手加入
    await program.methods
      .joinPool(amount)
      .accounts({
        pool: poolPda,
        opponent: firstOpponent.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([firstOpponent])
      .rpc();

    // 第二个对手尝试加入应该失败
    try {
      await program.methods
        .joinPool(amount)
        .accounts({
          pool: poolPda,
          opponent: secondOpponent.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([secondOpponent])
        .rpc();
      
      expect.fail("Should have failed to join already joined pool");
    } catch (error) {
      expect(error.message).to.include("PoolAlreadyJoined");
      console.log("Correctly prevented double join!");
    }
  });

  it("Fails to settle before expiry", async () => {
    const creator = Keypair.generate();
    await airdrop(creator.publicKey);

    const [poolPda] = await anchor.web3.PublicKey.findProgramAddress(
      [Buffer.from("pool"), creator.publicKey.toBuffer()],
      program.programId
    );
    const opponent = anchor.web3.Keypair.generate();
    const targetPrice = new anchor.BN(100 * LAMPORTS_PER_SOL);
    const currentPrice = new anchor.BN(90 * LAMPORTS_PER_SOL);
    const longExpiry = new anchor.BN(Math.floor(Date.now() / 1000) + 3600); // 1小时后
    const amount = new anchor.BN(1 * LAMPORTS_PER_SOL);

    await program.methods
      .createPool(MEME_TOKEN, targetPrice, currentPrice, longExpiry, amount, 0)
      .accounts({
        pool: poolPda,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    // 空投给对手
    await provider.connection.requestAirdrop(opponent.publicKey, 10 * LAMPORTS_PER_SOL);
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 对手加入
    await program.methods
      .joinPool(amount)
      .accounts({
        pool: poolPda,
        opponent: opponent.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([opponent])
      .rpc();

    // 尝试在到期前结算应该失败
    try {
      const finalPrice = new anchor.BN(110 * LAMPORTS_PER_SOL);
      await program.methods
        .settlePool(finalPrice)
        .accounts({
          pool: poolPda,
          creator: creator.publicKey,
          opponent: opponent.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      
      expect.fail("Should have failed to settle before expiry");
    } catch (error) {
      expect(error.message).to.include("PoolNotExpired");
      console.log("Correctly prevented early settlement!");
    }
  });
});